# AGENTS.md

Instructions for agents working in this repository.

## Approval required

**Never commit, tag, release, or publish without explicit approval from the user.**
Always show the proposed change and wait for a yes. This includes:

- `git commit`, `git push`, `git tag`
- `npm version`, `gh release create`, `npm publish`

Rationale: publishing is irreversible on npm, and commit history is shared. Prepare
changes, run the checks, then ask. Report exactly what would run (commands, files
touched, version numbers) so the user can approve with full information.

## Project

OpenCode V2 plugin that sends Windows toast notifications from WSL. It resolves the
`ntfytoast.exe` bundled with `toasted-notifier` and invokes it as a Windows process.
No Windows-side setup is required.

- Targets the **V2** plugin API (`@opencode/plugin`). V1 plugins do not run in V2.
- Published as `opencode-wsl-notify` on npm, version in `package.json`.
- CI publishes via OIDC trusted publishing on a published GitHub release.

## Layout

| Path | Purpose |
| --- | --- |
| `src/index.ts` | Plugin entrypoint: options, event loop, dispatch |
| `src/events.ts` | Event classification, labels, message rendering, dedupe state |
| `src/toast.ts` | Binary resolution, WSL path translation, process invocation |
| `test/smoke.mjs` | Unit tests for the above (pure logic; runs anywhere) |
| `test/verify.mjs` | End-to-end test: real `setup()` with a fake toast binary |
| `.github/workflows/publish.yml` | Release-triggered OIDC publish |

`dist/` is generated and gitignored; `prepublishOnly` rebuilds it.

## Commands

```sh
npm install        # install deps
npm run build      # tsc -> dist/
npm test           # build + unit tests (test/smoke.mjs)
npm run verify     # build + end-to-end test (test/verify.mjs)
npm run typecheck  # tsc --noEmit
```

Run `npm test` and `npm run verify` before proposing a commit. Both must pass.
`npm run verify` is the strongest signal — it exercises the real `setup()` against
a fake toast binary and asserts on the toasts produced.

## Technical constraints

Things that look like mistakes but are deliberate:

- **No `postinstall` script.** OpenCode installs plugins with Bun, which blocks
  lifecycle scripts, and npm does not preserve the exec bit from WSL. The plugin
  instead repairs the binary permission at runtime in `resolveBinary()`. Do not
  reintroduce a `postinstall` as a fix for permissions.
- **Events use `data`, not `properties`.** V2 payloads are on `event.data`; the
  `properties` fallback exists only for transitional releases.
- **Event names differ from V1.** `session.execution.failed` (not `session.error`)
  and `session.execution.started` (not `message.updated`). Verify against
  `@opencode/schema`'s event manifest rather than assuming V1 names.
- **Toast exit codes 1–5 are successes.** They report how the toast ended
  (`3` = `TimedOut`). A dispatch timeout is also treated as success.
- **Completions are coalesced.** One finished turn fires `session.execution.succeeded`
  *and* the deprecated `session.idle`, and streams can replay durable events.
  `claimCompletion()` ensures one toast per execution. Dedupe state resets in
  `beginTurn()`. Preserve this when touching completion handling.
- **The plugin is inert outside WSL** unless `wslOnly: false`. Tests set this.

## Testing notes

- `test/verify.mjs` drives the plugin through a fake context (`options`,
  `location`, `event.subscribe`, `session.get`) and a fake `ntfytoast.exe` that
  records its argv instead of showing a toast. Extend it for behavior changes;
  prefer asserting on produced toasts over mocking internals.
- `test/smoke.mjs` must not hardcode host assumptions. The `isWSL()` check derives
  its expectation from the same signals as the implementation because CI runs on
  plain Linux while local development is WSL.
- Tests must pass on both WSL and plain Linux (CI runs Ubuntu).

## Documentation

Keep docs concise and clear.

- `README.md` is for users: install, configure, troubleshoot. Keep it task-oriented.
- Prefer tables over prose for options and defaults.
- Every code sample must be runnable and accurate. Verify commands against
  `package.json` and paths against the real tree.
- No internal anchors unless the target heading exists — check before linking.
- Credit upstream work in `README.md` under Credits when adding dependencies.
- Update the README when behavior, options, or defaults change. Stale docs are bugs.

## Releasing

Only after explicit approval, and only when `npm test` and `npm run verify` pass:

```sh
npm version patch        # or minor / major
git push --follow-tags
gh release create vX.Y.Z --generate-notes
```

The release triggers CI, which publishes via OIDC. Notes:

- npm can take a few minutes to serve a newly published version. A 404 right after
  publishing is usually processing lag, not failure — check the workflow log for
  `+ package@version` before concluding it broke.
- OpenCode's plugin cache keys on `@latest`. A version published while a client is
  resolving can cache a failed install; clearing
  `~/.cache/opencode/npm/opencode-wsl-notify@latest` fixes it.
