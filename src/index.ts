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
  beginTurn,
  claimCompletion,
  classifyEvent,
  defaultRules,
  eventLocationOf,
  matchesLocation,
  projectLabel,
  renderMessage,
  sessionIDOf,
  sessionLabel,
  sessionLocationOf,
  sessionParentOf,
  sessionProjectOf,
  sessionTitleOf,
  type EventKind,
  type EventRules,
  type TurnState,
} from "./events.js"
import { createNotifier, isWSL } from "./toast.js"

export interface PluginOptions {
  /** Override the path to `ntfytoast.exe` (Linux or Windows form). */
  executablePath?: string
  /** Application name shown above the toast. Defaults to `OpenCode`. */
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

const DEFAULT_APP_ID = "OpenCode"

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
    // `ctx.location.directory` is the location directory, but the plugin context
    // does not always populate it; the project root is a reliable fallback.
    const ourDirectory =
      ctx.location?.directory ?? ctx.location?.project?.canonical ?? ctx.location?.project?.directory
    const ourProjectID = ctx.location?.project?.id
    const project = projectLabel(ctx.location?.project, ctx.location?.directory)

    // Everything we learn about a session in one place: its title (for the
    // toast), its owner (to scope events to this project), and its parent (to
    // tell subagent sessions apart).
    interface SessionMeta {
      title?: string
      directory?: string
      projectID?: string
      parentID?: string
      /** Set once the full session record has been read. */
      resolved?: boolean
    }
    const sessionMeta = new Map<string, SessionMeta>()

    const remember = (id: string, patch: SessionMeta) => {
      const merged: Record<string, unknown> = { ...(sessionMeta.get(id) ?? {}) }
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) merged[key] = value
      }
      sessionMeta.set(id, merged as SessionMeta)
    }

    // A finished turn surfaces as both `session.execution.succeeded` and the
    // deprecated `session.idle`, and a reconnecting event stream can replay
    // durable events, so coalesce completions to one toast per execution.
    const turns = new Map<string, TurnState>()

    // Read the full session record once per session. Titles can lag behind
    // execution, the record names the owning project/location (notification
    // events carry none), and `parentID` identifies a subagent session.
    const readSession = async (session: string): Promise<SessionMeta> => {
      const cached = sessionMeta.get(session)
      if (cached?.resolved) return cached
      try {
        const info = await ctx.session.get({ sessionID: session })
        remember(session, {
          title: typeof info?.title === "string" ? info.title.trim() || undefined : undefined,
          directory: typeof info?.location?.directory === "string" ? info.location.directory : undefined,
          projectID: typeof info?.projectID === "string" ? info.projectID : undefined,
          parentID: typeof info?.parentID === "string" && info.parentID !== "" ? info.parentID : undefined,
          resolved: true,
        })
        return sessionMeta.get(session) ?? {}
      } catch (error) {
        log("Could not read session", { session, error: String(error) })
        return cached ?? {}
      }
    }

    /** A session with a parent is a subagent, even when the event omits it. */
    const isSubagentSession = (session: string): boolean => sessionMeta.get(session)?.parentID !== undefined

    // OpenCode broadcasts every location's events to every project's plugin
    // instance, so this project must ignore events that belong to another. An
    // event envelope's location wins when present; notification events carry
    // none, so fall back to the session record, which names its own project.
    const ownsEvent = async (event: unknown, session?: string): Promise<boolean> => {
      // Warm the metadata cache so subagent/title info is available either way.
      if (session) await readSession(session)

      if (eventLocationOf(event) !== undefined) return matchesLocation(event, ourDirectory)

      if (session) {
        const meta = sessionMeta.get(session) ?? {}
        if (ourProjectID !== undefined && meta.projectID !== undefined) {
          return meta.projectID === ourProjectID
        }
        if (ourDirectory !== undefined && meta.directory !== undefined) {
          return meta.directory === ourDirectory
        }
      }
      return true
    }

    const fire = async (kind: EventKind, session?: string) => {
      const rule = rules[kind]
      if (!rule.enabled) return

      // Prefer a title captured from `session.created` / `session.renamed`, then
      // fall back to the session record, then to a short id.
      let title = session ? sessionMeta.get(session)?.title : undefined
      if (session && !title && rule.message.includes("{session}")) {
        title = (await readSession(session)).title
      }
      const sessionName = sessionLabel(title, session)

      const body = renderMessage(rule.message, { project, session: sessionName })
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
          // Remember everything a session reveals about itself. This runs for
          // every location's events, which is how each instance learns the owner
          // of sessions it does not own (notification events carry no location).
          const id = sessionIDOf(event)
          if (id) {
            const patch: SessionMeta = {}
            if (announcesTitle(event)) {
              const title = sessionTitleOf(event)
              if (title) patch.title = title
            }
            const directory = sessionLocationOf(event)
            if (directory) patch.directory = directory
            const projectID = sessionProjectOf(event)
            if (projectID) patch.projectID = projectID
            const parentID = sessionParentOf(event)
            if (parentID) patch.parentID = parentID
            if (Object.keys(patch).length > 0) remember(id, patch)
          }

          const classified = classifyEvent(event)
          if (!classified) continue

          const session = id
          const key = session ?? "global"
          log("Event classified", {
            type: (event as { type?: string }).type,
            role: classified.role,
            kind: classified.kind,
            session,
          })

          if (classified.role === "start") {
            // A new execution begins: reset the per-turn dedupe state.
            beginTurn(turns, key)
            continue
          }

          // Only this project's events become toasts. Notification events carry
          // no location, so this resolves the session's owner instead.
          if (!(await ownsEvent(event, session))) {
            log("Skipping event for another project", {
              type: (event as { type?: string }).type,
              session,
            })
            continue
          }

          let kind = classified.kind
          if (session && (kind === "complete" || kind === "subagent_complete") && isSubagentSession(session)) {
            kind = "subagent_complete"
          }

          if (kind === "complete" || kind === "subagent_complete") {
            const { claimed, startedAt } = claimCompletion(turns, key)
            if (!claimed) {
              log("Skipping duplicate completion", { kind, session })
              continue
            }

            if (
              options.minDuration &&
              options.minDuration > 0 &&
              startedAt !== undefined &&
              (Date.now() - startedAt) / 1000 < options.minDuration
            ) {
              continue
            }
          }

          log("Dispatching notification", { kind, session })
          await fire(kind, session)
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
  beginTurn,
  claimCompletion,
  classifyEvent,
  defaultRules,
  eventLocationOf,
  matchesLocation,
  projectLabel,
  renderMessage,
  sessionIDOf,
  sessionLabel,
  sessionLocationOf,
  sessionParentOf,
  sessionProjectOf,
  sessionTitleOf,
} from "./events.js"
export type { EventKind, EventRules, EventRule, Classified, ProjectLike, TurnState } from "./events.js"
