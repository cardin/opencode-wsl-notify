import { readFileSync } from "node:fs"
import { classifyEvent, sessionIDOf, sessionTitleOf, announcesTitle, renderMessage, defaultRules, projectLabel, sessionLabel, sessionParentOf, sessionProjectOf, sessionLocationOf, beginTurn, claimCompletion, eventLocationOf, matchesLocation } from "../dist/events.js"
import { resolveBinary, toWindowsPath, isWSL } from "../dist/toast.js"

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got ${JSON.stringify(actual)}\n        want ${JSON.stringify(expected)}`}`)
}

// --- Session title tracking ---
check("session.renamed announces title", announcesTitle({ type: "session.renamed", data: { sessionID: "s1", title: "Fix login" } }), true)
check("session.created announces title", announcesTitle({ type: "session.created", data: { sessionID: "s1", title: "Fix login" } }), true)
check("idle does not announce title", announcesTitle({ type: "session.idle", data: { sessionID: "s1" } }), false)
check("sessionTitleOf reads title", sessionTitleOf({ type: "session.renamed", data: { sessionID: "s1", title: "  Fix login  " } }), "Fix login")
check("blank title ignored", sessionTitleOf({ type: "session.renamed", data: { sessionID: "s1", title: "   " } }), undefined)
check("missing title ignored", sessionTitleOf({ type: "session.idle", data: { sessionID: "s1" } }), undefined)

// --- Windows path translation ---
check("mnt c path", toWindowsPath("/mnt/c/Users/me/t.exe"), "C:\\Users\\me\\t.exe")
check("mnt d path", toWindowsPath("/mnt/d/a/b.exe"), "D:\\a\\b.exe")
check("home path uses distro", toWindowsPath("/home/me/t.exe", "Ubuntu"), "\\\\wsl.localhost\\Ubuntu\\home\\me\\t.exe")

// --- Event classification against real V2 shapes (payload on `data`) ---
check("execution.started", classifyEvent({ type: "session.execution.started", data: { sessionID: "s1" } }),
  { role: "start", kind: "complete" })
check("execution.succeeded", classifyEvent({ type: "session.execution.succeeded", data: { sessionID: "s1" } }),
  { role: "notify", kind: "complete" })
check("session.idle", classifyEvent({ type: "session.idle", data: { sessionID: "s1" } }),
  { role: "notify", kind: "complete" })
check("execution.failed", classifyEvent({ type: "session.execution.failed", data: { sessionID: "s1", error: { message: "x" } } }),
  { role: "notify", kind: "error" })
check("permission.asked", classifyEvent({ type: "permission.asked", data: { sessionID: "s1", requestID: "p1" } }),
  { role: "notify", kind: "permission" })
check("subagent idle -> subagent_complete",
  classifyEvent({ type: "session.idle", data: { sessionID: "child", parentID: "parent" } }),
  { role: "notify", kind: "subagent_complete" })

// --- Ignored / defensive ---
check("unrelated event ignored", classifyEvent({ type: "session.text.delta", data: { sessionID: "s1" } }), undefined)
check("null ignored", classifyEvent(null), undefined)
check("garbage ignored", classifyEvent("nope"), undefined)
check("missing type ignored", classifyEvent({ data: {} }), undefined)

// --- Legacy V1 `properties` still readable ---
check("v1 properties fallback", sessionIDOf({ type: "session.idle", properties: { sessionID: "old" } }), "old")
check("v2 data preferred", sessionIDOf({ type: "session.idle", data: { sessionID: "new" } }), "new")

// --- Project / session labels ---
check("project label uses folder name", projectLabel({ id: "cd7149d1", canonical: "/home/me/opencode-wsl-notify", directory: "/home/me/opencode-wsl-notify" }), "opencode-wsl-notify")
check("project label falls back to directory", projectLabel({ id: "cd7149d1", directory: "/home/me/myapp" }), "myapp")
check("project label handles windows paths", projectLabel({ id: "cd7149d1", canonical: "C:\\Users\\me\\myapp" }), "myapp")
check("project label trims trailing slash", projectLabel({ id: "cd7149d1", canonical: "/home/me/myapp/" }), "myapp")
check("project label falls back to id", projectLabel({ id: "cd7149d1" }), "cd7149d1")
check("project label uses extra directory", projectLabel({ id: "cd7149d1" }, "/home/me/myapp"), "myapp")
check("project label prefers project path", projectLabel({ id: "cd7149d1", canonical: "/home/me/real" }, "/home/me/fallback"), "real")
check("project label without project", projectLabel(undefined), undefined)

check("session parent read", sessionParentOf({ type: "session.created", data: { sessionID: "child", parentID: "parent" } }), "parent")
check("session parent ignores self", sessionParentOf({ type: "session.created", data: { sessionID: "s1", parentID: "s1" } }), undefined)
check("session parent absent", sessionParentOf({ type: "session.idle", data: { sessionID: "s1" } }), undefined)
check("session parent legacy key", sessionParentOf({ type: "session.created", data: { sessionID: "child", parentSessionID: "parent" } }), "parent")

// --- Session payload owner fields ---
check("session project read", sessionProjectOf({ type: "session.created", data: { sessionID: "s1", projectID: "p1" } }), "p1")
check("session project absent", sessionProjectOf({ type: "session.idle", data: { sessionID: "s1" } }), undefined)
check("session location read", sessionLocationOf({ type: "session.created", data: { sessionID: "s1", location: { directory: "/home/me/app" } } }), "/home/me/app")
check("session location absent", sessionLocationOf({ type: "session.created", data: { sessionID: "s1" } }), undefined)

// --- Location scoping (events are broadcast to every project) ---
check("event location read", eventLocationOf({ type: "permission.asked", location: { directory: "/home/me/app" }, data: {} }), "/home/me/app")
check("event location absent", eventLocationOf({ type: "session.idle", data: {} }), undefined)
check("same location matches", matchesLocation({ type: "session.idle", location: { directory: "/home/me/app" }, data: {} }, "/home/me/app"), true)
check("other location rejected", matchesLocation({ type: "session.idle", location: { directory: "/home/me/other" }, data: {} }, "/home/me/app"), false)
check("missing event location allowed", matchesLocation({ type: "session.idle", data: {} }, "/home/me/app"), true)
check("unknown plugin location allows all", matchesLocation({ type: "session.idle", location: { directory: "/home/me/other" }, data: {} }, undefined), true)

// --- Completion coalescing (one toast per finished execution) ---
{
  const turns = new Map()
  beginTurn(turns, "s1", 1000)
  check("first completion claimed", claimCompletion(turns, "s1"), { claimed: true, startedAt: 1000 })
  check("paired completion skipped", claimCompletion(turns, "s1"), { claimed: false, startedAt: 1000 })

  beginTurn(turns, "s1", 2000)
  check("new turn claimed again", claimCompletion(turns, "s1"), { claimed: true, startedAt: 2000 })

  // A completion with no observed start still fires exactly once.
  check("orphan completion claimed", claimCompletion(turns, "s2"), { claimed: true, startedAt: undefined })
  check("orphan completion coalesced", claimCompletion(turns, "s2"), { claimed: false, startedAt: undefined })

  // Sessions are independent.
  check("other session unaffected", claimCompletion(turns, "s3"), { claimed: true, startedAt: undefined })
}

check("session label prefers title", sessionLabel("Fix login", "ses_f4c8aaaa"), "Fix login")
check("session label trims title", sessionLabel("  Fix login  ", "ses_f4c8aaaa"), "Fix login")
check("session label falls back to short id", sessionLabel(undefined, "ses_f4c8aaaa"), "ses_f4c8")
check("session label ignores blank title", sessionLabel("   ", "ses_f4c8aaaa"), "ses_f4c8")
check("session label without session", sessionLabel(undefined, undefined), undefined)

// --- Default titles name the event; body carries project/session ---
check("complete title", defaultRules.complete.title, "Session complete")
check("error title", defaultRules.error.title, "Session error")
check("permission title", defaultRules.permission.title, "Waiting for permission")
check("subagent title", defaultRules.subagent_complete.title, "Subagent finished")
check("permission message names session", defaultRules.permission.message, "{project} — {session}")
check("subagent message omits session", defaultRules.subagent_complete.message, "{project}")
check("subagent disabled by default", defaultRules.subagent_complete.enabled, false)

// --- Rendering / placeholder cleanup ---
check("project + session placeholders", renderMessage(defaultRules.complete.message, { project: "myapp", session: "Fix login" }), "myapp — Fix login")
check("empty placeholders render empty", renderMessage(defaultRules.complete.message, {}), "")
check("only project present", renderMessage(defaultRules.complete.message, { project: "myapp" }), "myapp")
check("empty session trims dash", renderMessage("Done - {session}", {}), "Done")

// --- Runtime self-healing of the execute bit ---
// OpenCode installs plugins with Bun, which blocks postinstall scripts, and npm
// does not reliably preserve the exec bit from WSL. resolveBinary() must repair it.
{
  const { chmodSync, statSync } = await import("node:fs")
  const exe = "node_modules/toasted-notifier/vendor/ntfyToast/ntfytoast.exe"
  chmodSync(exe, 0o644)
  check("exec bit stripped", (statSync(exe).mode & 0o111) !== 0, false)
  const healed = resolveBinary()
  check("resolveBinary repairs exec bit", healed !== undefined, true)
  check("exec bit restored", (statSync(exe).mode & 0o111) !== 0, true)
}

// --- Binary resolution ---
const bin = resolveBinary()
check("binary resolved", bin !== undefined, true)
check("binary from package", bin?.source, "package")
check("binary is executable path", bin?.linuxPath.endsWith("ntfytoast.exe"), true)
check("binary has windows form", bin?.windowsPath.endsWith("ntfytoast.exe"), true)
// isWSL() must reflect the actual host: true under WSL, false on a plain Linux
// runner such as GitHub Actions. Assert agreement with the environment rather
// than a fixed value so the suite passes on both.
//
// On a plain Linux runner isWSL() also inspects /proc/version, so derive the
// expectation the same way the implementation does.
let envSaysWSL = Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)
if (!envSaysWSL) {
  try {
    const v = readFileSync("/proc/version", "utf8")
    envSaysWSL = /microsoft|wsl/i.test(v)
  } catch {
    envSaysWSL = false
  }
}
check(
  `isWSL matches host (detected=${isWSL()}, host=${envSaysWSL ? "WSL" : "plain Linux"})`,
  isWSL(),
  envSaysWSL,
)

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
