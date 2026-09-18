import { classifyEvent, sessionIDOf, sessionTitleOf, announcesTitle, renderMessage, defaultRules } from "../dist/events.js"
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

// --- Rendering / placeholder cleanup ---
check("project + session placeholders", renderMessage(defaultRules.complete.message, { project: "myapp", session: "Fix login" }), "Session complete — myapp — Fix login")
check("empty placeholders trim separators", renderMessage(defaultRules.complete.message, {}), "Session complete")
check("only project present", renderMessage(defaultRules.complete.message, { project: "myapp" }), "Session complete — myapp")
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
check("isWSL detects true in this WSL env", isWSL(), true)

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
