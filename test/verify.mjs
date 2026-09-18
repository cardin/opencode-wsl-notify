#!/usr/bin/env node
/**
 * Local end-to-end verification for opencode-wsl-notify.
 *
 * Loads the built plugin, runs its real `setup()` against a fake plugin context
 * and a fake toast binary, and reports the toasts that would have been shown.
 * Verifies readable project/session names and that one finished turn produces
 * exactly one toast. No Windows, no OpenCode restart, no publishing required.
 *
 *   npm run verify
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const PROJECT_ID = "5c012ff40a568d876e9369beaa7e840d911e3678"
const PROJECT_NAME = "opencode-wsl-notify"
const OTHER_PROJECT_ID = "bac72d1ab1fcbbbdef8d4fc73071c9a59b6aae11"
const OTHER_DIRECTORY = "/home/cardi/projects_l"

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed++
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got  ${JSON.stringify(actual)}\n        want ${JSON.stringify(expected)}`}`,
  )
}

// A fake `ntfytoast.exe`: it records the arguments instead of showing a toast.
const dir = mkdtempSync(join(tmpdir(), "opencode-wsl-notify-verify-"))
const logPath = join(dir, "toasts.jsonl")
const fakeToast = join(dir, "fake-toast.mjs")
writeFileSync(
  fakeToast,
  `#!/usr/bin/env node\n` +
    `import { appendFileSync } from "node:fs"\n` +
    `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + "\\n")\n`,
)
chmodSync(fakeToast, 0o755)

/** Toasts recorded so far, decoded from the fake binary's arguments. */
function toasts() {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const args = JSON.parse(line)
      return {
        app: args[args.indexOf("-appID") + 1],
        title: args[args.indexOf("-t") + 1],
        message: args[args.indexOf("-m") + 1],
      }
    })
}

/** An event stream the test can push into, matching `ctx.event.subscribe()`. */
function createStream() {
  const buffer = []
  let waiter
  return {
    push(event) {
      if (waiter) {
        const resolve = waiter
        waiter = undefined
        resolve(event)
        return
      }
      buffer.push(event)
    },
    subscribe() {
      return {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (buffer.length > 0) {
              yield buffer.shift()
              continue
            }
            yield await new Promise((resolve) => (waiter = resolve))
          }
        },
      }
    },
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait until no new toasts have appeared for a short quiet period. */
async function settle(maxMs = 3000) {
  const start = Date.now()
  let last = -1
  while (Date.now() - start < maxMs) {
    const count = toasts().length
    if (count === last) {
      await wait(150)
      if (toasts().length === count) return
    }
    last = count
    await wait(100)
  }
}

/** Titles the fake session record can resolve, keyed by session id. */
const sessionTitles = {
  ses_abc: "Fix the parser",
  ses_late: "Title generated later",
}

/** Owner the fake session record reports, keyed by session id. */
const sessionOwners = {}

/** Parent the fake session record reports, keyed by session id. */
const sessionParents = {}

async function run(events, options = {}) {
  const { omitLocationDirectory, ...pluginOptions } = options
  rmSync(logPath, { force: true })
  const stream = createStream()
  const plugin = (await import(pathToFileURL(join(repoRoot, "dist", "index.js")).href)).default

  const location = {
    project: { id: PROJECT_ID, directory: repoRoot, canonical: repoRoot },
  }
  if (!omitLocationDirectory) location.directory = repoRoot

  const ctx = {
    options: { wslOnly: false, executablePath: fakeToast, ...pluginOptions },
    location,
    event: { subscribe: () => stream.subscribe() },
    session: {
      async get({ sessionID }) {
        const owner = sessionOwners[sessionID]
        return {
          id: sessionID,
          ...(sessionTitles[sessionID] ? { title: sessionTitles[sessionID] } : {}),
          ...(sessionParents[sessionID] ? { parentID: sessionParents[sessionID] } : {}),
          projectID: owner?.projectID ?? PROJECT_ID,
          location: { directory: owner?.directory ?? repoRoot },
        }
      },
    },
  }

  const cleanup = await plugin.setup(ctx)
  for (const event of events) stream.push(event)
  await settle()
  if (cleanup) await cleanup()
  return toasts()
}

const started = (sessionID) => ({ type: "session.execution.started", data: { sessionID } })
const succeeded = (sessionID) => ({ type: "session.execution.succeeded", data: { sessionID } })
const idle = (sessionID) => ({ type: "session.idle", data: { sessionID } })
const created = (sessionID, extra = {}) => ({ type: "session.created", data: { sessionID, ...extra } })

// --- One finished turn renders readable names and toasts exactly once ---
{
  const result = await run([
    created("ses_abc", { title: "Fix the parser" }),
    started("ses_abc"),
    succeeded("ses_abc"),
    idle("ses_abc"),
  ])
  check("one toast per finished turn", result.length, 1)
  check("toast app name", result[0]?.app, "OpenCode")
  check("toast title is the event", result[0]?.title, "Session complete")
  check(
    "readable project and session",
    result[0]?.message,
    `${PROJECT_NAME} — Fix the parser`,
  )
  console.log(`        toast: ${JSON.stringify(result[0])}`)
}

// --- A title that arrives after the event is read from the session record ---
{
  const result = await run([started("ses_late"), succeeded("ses_late")])
  check("title fetched from session record", result.length, 1)
  check(
    "late title rendered",
    result[0]?.message,
    `${PROJECT_NAME} — Title generated later`,
  )
}

// --- Two separate turns each get their own toast (dedupe resets per turn) ---
{
  const result = await run([
    started("ses_abc"),
    succeeded("ses_abc"),
    idle("ses_abc"),
    started("ses_abc"),
    succeeded("ses_abc"),
  ])
  check("two turns produce two toasts", result.length, 2)
}

// --- Subagents do not masquerade as top-level sessions ---
{
  const events = [
    created("ses_child", { parentID: "ses_abc", title: "Subagent work" }),
    started("ses_child"),
    succeeded("ses_child"),
  ]
  const suppressed = await run(events)
  check("subagent suppressed while disabled", suppressed.length, 0)

  const enabled = await run(events, { events: { subagent_complete: { enabled: true } } })
  check("subagent toasts when enabled", enabled.length, 1)
  check("subagent title", enabled[0]?.title, "Subagent finished")
  check(
    "subagent message",
    enabled[0]?.message,
    PROJECT_NAME,
  )
}

// --- Subagent detected from the session record when the event omits parentID ---
{
  sessionParents.ses_child_record = "ses_abc"
  const events = [
    // The event carries no parentID; only the session record knows it is a subagent.
    created("ses_child_record", { title: "Subagent work" }),
    started("ses_child_record"),
    succeeded("ses_child_record"),
  ]
  const suppressed = await run(events)
  check("record-detected subagent suppressed", suppressed.length, 0)

  const enabled = await run(events, { events: { subagent_complete: { enabled: true } } })
  check("record-detected subagent toasts when enabled", enabled.length, 1)
  check("record-detected subagent title", enabled[0]?.title, "Subagent finished")
}

// --- Permission toasts name the session (via the session record) ---
{
  const result = await run([{ type: "permission.asked", data: { sessionID: "ses_abc", requestID: "perm_1" } }])
  check("permission toasts", result.length, 1)
  check("permission title", result[0]?.title, "Waiting for permission")
  check("permission message names session", result[0]?.message, `${PROJECT_NAME} — Fix the parser`)
}

// --- Events for another project do not toast (one plugin instance per project) ---
{
  const event = {
    type: "permission.asked",
    location: { directory: OTHER_DIRECTORY },
    data: { sessionID: "ses_abc", requestID: "perm_2" },
  }
  const ignored = await run([event])
  check("other location event ignored", ignored.length, 0)

  const kept = await run([{ ...event, location: { directory: repoRoot } }])
  check("own location event kept", kept.length, 1)
}

// --- Notification events carry no location; ownership comes from the session ---
{
  sessionOwners.ses_other = { projectID: OTHER_PROJECT_ID, directory: OTHER_DIRECTORY }

  // A foreign session's completion has no `location` field, so only the
  // `session.created` payload reveals that it belongs to another project.
  const foreign = await run([
    {
      type: "session.created",
      location: { directory: OTHER_DIRECTORY },
      data: {
        sessionID: "ses_other",
        projectID: OTHER_PROJECT_ID,
        location: { directory: OTHER_DIRECTORY },
      },
    },
    started("ses_other"),
    succeeded("ses_other"),
  ])
  check("foreign completion ignored", foreign.length, 0)

  // The same shape for our own session still toasts, exactly once.
  const own = await run([
    {
      type: "session.created",
      location: { directory: repoRoot },
      data: { sessionID: "ses_abc", projectID: PROJECT_ID, location: { directory: repoRoot } },
    },
    started("ses_abc"),
    succeeded("ses_abc"),
  ])
  check("own completion toasted", own.length, 1)
}

// --- Mid-session start: ownership resolved from the session record ---
{
  sessionOwners.ses_remote = { projectID: OTHER_PROJECT_ID, directory: OTHER_DIRECTORY }

  const remote = await run([{ type: "permission.asked", data: { sessionID: "ses_remote", requestID: "perm_3" } }])
  check("remote session ignored via record", remote.length, 0)

  const local = await run([{ type: "permission.asked", data: { sessionID: "ses_abc", requestID: "perm_4" } }])
  check("local session toasted via record", local.length, 1)
}

// --- Falls back to the project root when ctx.location has no directory ---
{
  const foreign = await run(
    [{ type: "permission.asked", location: { directory: OTHER_DIRECTORY }, data: { sessionID: "ses_abc", requestID: "perm_5" } }],
    { omitLocationDirectory: true },
  )
  check("project-root fallback rejects other dir", foreign.length, 0)

  const own = await run(
    [{ type: "permission.asked", location: { directory: repoRoot }, data: { sessionID: "ses_abc", requestID: "perm_6" } }],
    { omitLocationDirectory: true },
  )
  check("project-root fallback keeps own dir", own.length, 1)
}

// --- minDuration still suppresses very short work ---
{
  const result = await run([started("ses_abc"), succeeded("ses_abc")], { minDuration: 3600 })
  check("short session suppressed", result.length, 0)
}

rmSync(dir, { recursive: true, force: true })

console.log(failed === 0 ? "\nAll verification checks passed." : `\n${failed} check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
