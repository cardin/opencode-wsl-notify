/**
 * Locating and invoking the bundled Windows toast binary (`ntfytoast.exe`).
 *
 * OpenCode runs inside WSL, where `process.platform === "linux"`. Every
 * cross-platform notifier would therefore pick a Linux backend (`notify-send`),
 * which does nothing in a WSL environment without a notification daemon. To get
 * real Windows toasts we invoke the Windows executable that `toasted-notifier`
 * ships inside its `vendor/` directory.
 *
 * WSL can execute Windows binaries directly, so no PowerShell and no Windows-side
 * module install is required.
 */

import { createRequire } from "node:module"
import { execFile } from "node:child_process"
import { accessSync, chmodSync, constants } from "node:fs"
import { dirname, join, resolve } from "node:path"

const require = createRequire(import.meta.url)

/** Relative location of the bundled toast executable inside the package. */
const VENDOR_RELATIVE = join("vendor", "ntfyToast", "ntfytoast.exe")

export interface ResolvedBinary {
  /** Linux path to the executable. */
  linuxPath: string
  /** Windows path to the executable, suitable for a Windows process. */
  windowsPath: string
  /** How the path was found, for diagnostics. */
  source: "configured" | "package" | "path"
}

export interface ResolveOptions {
  /** Explicit path (Linux or Windows form) provided by the user. */
  customPath?: string
  /** Working directory used when resolving relative custom paths. */
  cwd?: string
}

/**
 * Convert a WSL path to its Windows equivalent.
 *
 * `/mnt/c/Users/me/x.exe` -> `C:\Users\me\x.exe`
 * `/home/me/x.exe`        -> `\\wsl.localhost\<distro>\home\me\x.exe`
 *
 * Windows processes cannot interpret `/mnt/c/...`, so this conversion is
 * required before handing the path to the executable.
 */
export function toWindowsPath(linuxPath: string, distro?: string): string {
  const normalized = linuxPath.replace(/\//g, "\\")

  const drive = /^\\mnt\\([a-z])\\?(.*)$/i.exec(normalized)
  if (drive && drive[1]) {
    const rest = drive[2] ?? ""
    return `${drive[1].toUpperCase()}:\\${rest}`
  }

  const name = distro ?? process.env.WSL_DISTRO_NAME ?? "WSL"
  const suffix = normalized.replace(/^\\+/, "")
  return `\\\\wsl.localhost\\${name}\\${suffix}`
}

/** True when the process is running inside WSL rather than native Linux. */
export function isWSL(): boolean {
  if (process.platform !== "linux") return false
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true
  try {
    const version = require("node:fs").readFileSync("/proc/version", "utf8") as string
    return /microsoft|wsl/i.test(version)
  } catch {
    return false
  }
}

/**
 * Ensure a Windows binary is executable.
 *
 * OpenCode installs npm plugins with Bun, which blocks `postinstall` lifecycle
 * scripts by default (unless the package is trusted). npm also does not reliably
 * preserve the execute bit for files installed from WSL. Both leave the vendored
 * `ntfytoast.exe` non-executable, which makes notifications silently fail.
 *
 * Correcting this at resolution time keeps the plugin working no matter how it
 * was installed, so listing it in `opencode.jsonc` is enough.
 */
function ensureExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    // Not executable (or missing) — try to fix it.
  }

  try {
    chmodSync(path, 0o755)
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function executableInPackage(): string | undefined {
  try {
    const entry = require.resolve("toasted-notifier/package.json")
    const candidate = join(dirname(entry), VENDOR_RELATIVE)
    return ensureExecutable(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

function executableOnPath(): string | undefined {
  const entries = (process.env.PATH ?? "").split(":").filter(Boolean)
  for (const entry of entries) {
    const candidate = join(entry, "ntfytoast.exe")
    if (ensureExecutable(candidate)) return candidate
  }
  return undefined
}

/**
 * Find the toast executable without requiring Windows-side setup.
 *
 * Order: explicit configuration, then the binary bundled with the dependency,
 * then a `ntfytoast.exe` on `PATH`.
 */
export function resolveBinary(options: ResolveOptions = {}): ResolvedBinary | undefined {
  if (options.customPath) {
    const linuxPath = resolve(options.cwd ?? process.cwd(), options.customPath)
    if (!ensureExecutable(linuxPath)) return undefined
    return {
      linuxPath,
      windowsPath: toWindowsPath(linuxPath),
      source: "configured",
    }
  }

  const bundled = executableInPackage()
  if (bundled) {
    return { linuxPath: bundled, windowsPath: toWindowsPath(bundled), source: "package" }
  }

  const onPath = executableOnPath()
  if (onPath) {
    return { linuxPath: onPath, windowsPath: toWindowsPath(onPath), source: "path" }
  }

  return undefined
}

export interface ToastOptions {
  title: string
  message: string
  /** Optional application id shown above the toast. */
  appID?: string
  /** Optional absolute path to an icon. Must be a Windows-visible path. */
  icon?: string
}

export interface ToastResult {
  ok: boolean
  error?: string
  /** Raw stdout/stderr from the binary when it failed. */
  detail?: string
}

/**
 * NtfyToast exit codes. Anything in this range means the toast was shown; the
 * code just reports how it ended. Notably `TimedOut` (3) is the normal outcome
 * for a toast that simply expired, and must not be treated as a failure.
 *
 *   -1 Failed, 0 Success, 1 Hidden, 2 Dismissed, 3 TimedOut,
 *   4 ButtonPressed, 5 TextEntered
 */
const BENIGN_EXIT_CODES = new Set([1, 2, 3, 4, 5])

/**
 * How long to wait for the toast binary. The binary blocks until the toast is
 * dismissed or expires (up to ~7s for `short`, ~25s for `long`), so the default
 * is generous. If it is still running at the limit the toast has already been
 * dispatched, so a timeout is not a failure.
 */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Invoke the toast binary. Resolves (never rejects) so a failed notification
 * cannot break the OpenCode session that triggered it.
 */
export function showToast(
  binary: ResolvedBinary,
  options: ToastOptions,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ToastResult> {
  const args = ["-t", options.title, "-m", options.message]

  if (options.appID) args.push("-appID", options.appID)
  if (options.icon) args.push("-p", options.icon)

  return new Promise<ToastResult>((resolvePromise) => {
    execFile(
      binary.linuxPath,
      args,
      { timeout: timeoutMs, windowsHide: true },
      (error, _stdout, stderr) => {
        if (!error) {
          resolvePromise({ ok: true })
          return
        }

        // The binary exited with a status that still means "shown".
        const code = (error as NodeJS.ErrnoException & { code?: number | string }).code
        if (typeof code === "number" && BENIGN_EXIT_CODES.has(code)) {
          resolvePromise({ ok: true })
          return
        }

        // Killed by the timeout: the toast was already dispatched.
        const killed = (error as { killed?: boolean; signal?: string | null }).killed === true
        if (killed || (error as { signal?: string | null }).signal) {
          resolvePromise({ ok: true })
          return
        }

        resolvePromise({ ok: false, error: error.message, detail: stderr || undefined })
      },
    )
  })
}

/** Build a one-off invoker bound to a resolved binary. */
export function createNotifier(options: ResolveOptions = {}) {
  const binary = resolveBinary(options)

  return {
    binary,
    available: binary !== undefined,
    notify(toast: ToastOptions): Promise<ToastResult> {
      if (!binary) {
        return Promise.resolve({ ok: false, error: "ntfytoast.exe could not be located" })
      }
      return showToast(binary, toast)
    },
  }
}
