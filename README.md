# opencode-wsl-notify

Windows toast notifications for [OpenCode](https://opencode.ai) (V2) running inside **WSL** — with **no Windows-side setup**.

No PowerShell modules to install. No BurntToast. No scripts on the Windows side. Just an npm install.

```
npm install opencode-wsl-notify
```

---

## Why this exists

OpenCode runs inside WSL, where `process.platform === "linux"`. Every cross-platform notifier therefore picks a Linux backend (`notify-send`), which does nothing in WSL without a notification daemon. The usual workarounds ask you to install a PowerShell module or hand-write a bridge script on the Windows side.

This package instead invokes the Windows toast executable that ships *inside* the npm dependency. WSL can run Windows binaries directly, so nothing needs to be installed on Windows.

It is built against the **OpenCode V2 plugin API** (`@opencode/plugin`), not the V1 API, which V2 does not run.

---

## Install

Just add it to your OpenCode config — no `npm install` needed. OpenCode installs
npm plugins itself:

```jsonc title="~/.config/opencode/opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-wsl-notify"]
}
```

Restart OpenCode. You should get Windows toasts when a session finishes, errors,
or needs permission.

<Note>
OpenCode installs npm plugins with Bun, which blocks `postinstall` lifecycle
scripts by default. This package does **not** rely on `postinstall`: it repairs
the executable permission at runtime during `setup()`, so it works regardless of
how it was installed.
</Note>

If you prefer to manage the dependency yourself, `npm install opencode-wsl-notify`
in your config directory also works, and local plugins are loaded from
`~/.config/opencode/plugins/`.

## Configuration

Options are passed through the object form of a plugin entry:

```jsonc title="~/.config/opencode/opencode.jsonc"
{
  "plugins": [
    {
      "package": "opencode-wsl-notify",
      "options": {
        "debug": true,
        "minDuration": 5,
        "appID": "OpenCode-WSL-Notify",
        "events": {
          "subagent_complete": { "enabled": true },
          "complete": { "message": "Done — {project}" }
        }
      }
    }
  ]
}
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `executablePath` | string | auto | Explicit path to `ntfytoast.exe`. Linux (`/mnt/c/...`) or Windows (`C:\...`) form. |
| `appID` | string | `OpenCode-WSL-Notify` | Application id shown above the toast. |
| `wslOnly` | boolean | `true` | Only notify when running inside WSL. Set `false` to force on other platforms. |
| `events` | object | see below | Per-event `enabled`, `title`, and `message`. |
| `minDuration` | number | `0` | Skip `complete` notifications for sessions shorter than this many seconds. |
| `debug` | boolean | `false` | Log diagnostics to stderr. |

### Events

| Event | Default | Fires on |
| --- | --- | --- |
| `complete` | on | `session.idle` / `session.execution.succeeded` |
| `error` | on | `session.execution.failed` |
| `permission` | on | `permission.asked` |
| `subagent_complete` | off | a subagent session finishing |

Default messages:

| Event | Message |
| --- | --- |
| `complete` | `Session complete — {project} — {session}` |
| `error` | `Session error — {project} — {session}` |
| `permission` | `Waiting for permission — {project}` |
| `subagent_complete` | `Subagent finished — {project}` |

### Message placeholders

| Placeholder | Resolves to |
| --- | --- |
| `{project}` | Project id (folder name) from the plugin location |
| `{session}` | Session title, or the first 8 characters of the session id if the title is not yet known |

Titles are learned from `session.created` and `session.renamed`, so the first
notification for a session may show an id before the title is generated.

Placeholders that resolve to empty are removed along with their trailing
separator, so `"Session complete — {project} — {session}"` degrades cleanly to
`"Session complete — myapp"` or just `"Session complete"`. To drop a placeholder
entirely, remove it from the message:

```jsonc
{ "events": { "complete": { "message": "Done — {project}" } } }
```

---

## How it works

1. OpenCode V2 calls the plugin's `setup(ctx)`.
2. The plugin resolves the bundled `ntfytoast.exe` from the `toasted-notifier` dependency.
3. It subscribes to `ctx.event.subscribe()`.
4. Matching events map to toasts, which run as a Windows process from WSL.

The plugin is deliberately inert outside WSL, since native Linux has a real notification daemon and OpenCode's built-in [`attention`](https://opencode.ai/v2/docs/cli/config) settings cover it. On Windows 11 with WSLg, try the built-in `attention.notifications` setting first — it may already do what you need.

### WSL path translation

Windows processes cannot read `/mnt/c/...`, so paths are translated before use:

| WSL path | Windows path |
| --- | --- |
| `/mnt/c/Users/me/x.exe` | `C:\Users\me\x.exe` |
| `/home/me/x.exe` | `\\wsl.localhost\<distro>\home\me\x.exe` |

The distro name comes from `WSL_DISTRO_NAME`.

---

## Troubleshooting

**No notifications appear.**

Enable `debug` and check stderr:

```jsonc
{ "plugins": [{ "package": "opencode-wsl-notify", "options": { "debug": true } }] }
```

If it reports the binary could not be located, the vendored `ntfytoast.exe` is
missing or could not be made executable. Set `executablePath` to an explicit copy.

**Do I need to run `npm install` or fix permissions manually?**

No. The plugin makes the binary executable at runtime, because OpenCode's Bun-based
installer blocks `postinstall` scripts and npm does not reliably preserve the
execute bit from WSL. There is no manual permission step.

**Toasts show "NtfyToast" instead of "OpenCode-WSL-Notify".**

The `appID` is passed through to the toast binary, but Windows only honors an application name for an appID that is **registered** on the system. Without registration the label falls back to the toast vendor's name.

To make the branding stick, register a Start Menu shortcut once:

```sh
node_modules/toasted-notifier/vendor/ntfyToast/ntfytoast.exe \
  -install "OpenCode-WSL-Notify\OpenCode-WSL-Notify.lnk" \
  "C:\Windows\System32\cmd.exe" \
  "OpenCode-WSL-Notify"
```

Then the default `appID` resolves to a registered name. Set a custom `appID` if you registered a different one.

**"Session error" notifications never fire.**

V2 emits `session.execution.failed`, which this plugin handles. If you are on a transitional release that still emits V1's `session.error`, that is handled too.

---

## Development

```sh
npm install
npm run build        # tsc -> dist/
npm test             # smoke tests for path/event/render logic
npm run typecheck
```

The smoke tests cover Windows path translation, event classification against real V2 event shapes, placeholder rendering, and binary resolution.

---

## Credits

This package is a thin OpenCode integration layer standing on other people's work. The actual Windows toast rendering and the cross-platform notification plumbing come from:

| Project | Author | License | Role |
| --- | --- | --- | --- |
| [`toasted-notifier`](https://github.com/Aetherinox/node-toasted-notifier) | [Aetherinox](https://github.com/Aetherinox) | MIT | Cross-platform Node notification library this package depends on |
| [`ntfy-toast`](https://github.com/Aetherinox/ntfy-toast) | [Aetherinox](https://github.com/Aetherinox) | MIT | The bundled `ntfytoast.exe` that renders the Windows toast |
| [`SnoreToast`](https://github.com/KDE/snoretoast) | [KDE](https://kde.org) | LGPL-3.0 | Original project `ntfy-toast` is based on |
| [`node-notifier`](https://github.com/mikaelbr/node-notifier) | [Mikael Brevik](https://github.com/mikaelbr) | MIT | Original library that `toasted-notifier` forked |

`ntfy-toast` is a fork of SnoreToast with fixes and additional features. Thank you to these maintainers — this plugin would be a pile of PowerShell scripts without them.

## License

MIT
