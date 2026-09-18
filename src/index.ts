/**
 * opencode-wsl-notify — OpenCode V2 plugin.
 *
 * Sends Windows toast notifications for OpenCode sessions running inside WSL.
 * Built on the OpenCode V2 plugin API (`@opencode/plugin`).
 */

import type { Plugin as OpenCodePluginNamespace } from "@opencode/plugin"

type OpenCodePlugin = OpenCodePluginNamespace.Plugin

import {
  announcesTitle,
  classifyEvent,
  defaultRules,
  renderMessage,
  sessionIDOf,
  sessionTitleOf,
  type EventKind,
  type EventRules,
} from "./events.js"
import { createNotifier, isWSL } from "./toast.js"

export interface PluginOptions {
  /** Override the path to `ntfytoast.exe` (Linux or Windows form). */
  executablePath?: string
  /** Application id shown above the toast. Defaults to `OpenCode-WSL-Notify`. */
  appID?: string
  /** Only send notifications when running inside WSL. Defaults to true. */
  wslOnly?: boolean
  /** Per-event enablement and text. Merged over the defaults. */
  events?: Partial<Record<EventKind, Partial<EventRules[EventKind]>>>
  /** Suppress `complete` notifications for sessions shorter than this (seconds). */
  minDuration?: number
  /** Log diagnostics to stderr. Defaults to false. */
  debug?: boolean
}

const DEFAULT_APP_ID = "OpenCode-WSL-Notify"

function mergeRules(overrides: PluginOptions["events"]): EventRules {
  const rules: EventRules = structuredClone(defaultRules)
  if (!overrides) return rules

  for (const [kind, value] of Object.entries(overrides)) {
    if (!value) continue
    const key = kind as EventKind
    if (!rules[key]) continue
    rules[key] = { ...rules[key], ...value }
  }
  return rules
}

export default {
  id: "opencode-wsl-notify",

  async setup(ctx) {
    const options = (ctx.options ?? {}) as PluginOptions
    const debug = options.debug === true

    const log = (message: string, extra?: unknown) => {
      if (!debug) return
      const suffix = extra === undefined ? "" : ` ${JSON.stringify(extra)}`
      process.stderr.write(`[opencode-wsl-notify] ${message}${suffix}\n`)
    }

    // A native Linux (non-WSL) host has a real notification daemon, and this
    // plugin targets Windows toasts specifically. Let OpenCode's built-in
    // `attention` settings handle those environments.
    if (options.wslOnly !== false && !isWSL()) {
      log("Not running in WSL; opencode-wsl-notify is inert on this host")
      return
    }

    const notifier = createNotifier({ customPath: options.executablePath })

    // Resolve the working directory from the plugin location, used for relative
    // `executablePath` values.
    if (!notifier.available) {
      log(
        "Could not locate ntfytoast.exe; notifications are disabled. " +
          "Reinstall the package (postinstall fixes permissions) or set `executablePath`.",
      )
      return
    }

    log("Resolved toast binary", {
      source: notifier.binary?.source,
      path: notifier.binary?.linuxPath,
    })

    const rules = mergeRules(options.events)
    const project = ctx.location?.project?.id
    const startedAt = new Map<string, number>()
    const sessionTitles = new Map<string, string>()

    const fire = async (kind: EventKind, session?: string) => {
      const rule = rules[kind]
      if (!rule.enabled) return

      // Prefer the session title; fall back to a short id so the toast still
      // identifies which session it refers to.
      const title = session ? sessionTitles.get(session) : undefined
      const sessionLabel = title ?? (session ? session.slice(0, 8) : undefined)

      const body = renderMessage(rule.message, { project, session: sessionLabel })
      const result = await notifier.notify({
        title: rule.title,
        message: body,
        appID: options.appID ?? DEFAULT_APP_ID,
      })

      if (!result.ok) {
        log("Notification failed", { kind, error: result.error, detail: result.detail })
      }
    }

    const controller = new AbortController()

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          // Remember session titles so notifications can name the session.
          if (announcesTitle(event)) {
            const id = sessionIDOf(event)
            const title = sessionTitleOf(event)
            if (id && title) sessionTitles.set(id, title)
          }

          const classified = classifyEvent(event)
          if (!classified) continue

          const session = sessionIDOf(event)

          if (classified.role === "start") {
            // Track when a turn started so `minDuration` can skip very short work.
            if (session) startedAt.set(session, Date.now())
            continue
          }

          if (classified.kind === "complete" || classified.kind === "subagent_complete") {
            const key = session ?? "global"
            const since = startedAt.get(key)
            startedAt.delete(key)
            if (
              options.minDuration &&
              options.minDuration > 0 &&
              since !== undefined &&
              (Date.now() - since) / 1000 < options.minDuration
            ) {
              continue
            }
          }

          await fire(classified.kind, session)
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          log("Event subscription ended", String(error))
        }
      }
    })()

    return () => controller.abort()
  },
} satisfies OpenCodePlugin

export { createNotifier, isWSL, resolveBinary, toWindowsPath } from "./toast.js"
export {
  announcesTitle,
  classifyEvent,
  defaultRules,
  renderMessage,
  sessionIDOf,
  sessionTitleOf,
} from "./events.js"
export type { EventKind, EventRules, EventRule, Classified } from "./events.js"
