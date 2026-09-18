/**
 * Mapping from OpenCode V2 events to notification messages.
 *
 * Event names and payload shapes are taken from `@opencode/schema`'s
 * `event-manifest`. V2 renamed several lifecycle events relative to V1:
 *
 *   V1 `session.error`          -> V2 `session.execution.failed`
 *   V1 `message.updated`        -> V2 `session.execution.started`
 *   V1 `session.idle` (done)    -> V2 `session.idle` (execution finished)
 *   V1 `question.asked`         -> V2 has no dedicated event; questions surface
 *                                  through the permission flow.
 *
 * Payloads are read from `event.data`, never `event.properties`.
 */

export type EventKind = "complete" | "error" | "permission" | "subagent_complete"

export interface EventRule {
  /** Notify on this event. */
  enabled: boolean
  /** Toast title. */
  title: string
  /** Toast body. Supports `{project}` and `{session}` placeholders. */
  message: string
}

export type EventRules = Record<EventKind, EventRule>

export const defaultRules: EventRules = {
  complete: {
    enabled: true,
    title: "OpenCode",
    message: "Session complete — {project} — {session}",
  },
  error: {
    enabled: true,
    title: "OpenCode",
    message: "Session error — {project} — {session}",
  },
  permission: {
    enabled: true,
    title: "OpenCode",
    message: "Waiting for permission — {project}",
  },
  subagent_complete: {
    enabled: false,
    title: "OpenCode",
    message: "Subagent finished — {project}",
  },
}

/** Event types this plugin reacts to. */
const EXECUTION_STARTED = "session.execution.started"
const EXECUTION_STARTED_LEGACY = "message.updated"
const EXECUTION_SUCCEEDED = "session.execution.succeeded"
const EXECUTION_FAILED = "session.execution.failed"
const SESSION_IDLE = "session.idle"
const SESSION_ERROR = "session.error"
const SESSION_RENAMED = "session.renamed"
const SESSION_CREATED = "session.created"
const PERMISSION_ASKED = "permission.asked"

interface EventLike {
  type?: unknown
  data?: Record<string, unknown>
  properties?: Record<string, unknown>
}

function readEvent(event: unknown): EventLike | undefined {
  if (!event || typeof event !== "object") return undefined
  const record = event as EventLike
  if (typeof record.type !== "string") return undefined
  return record
}

/**
 * V2 carries payloads on `data`; V1 used `properties`. Read both so the plugin
 * keeps working if it is loaded by a transitional release.
 */
function payload(event: EventLike): Record<string, unknown> {
  if (event.data && typeof event.data === "object") return event.data
  if (event.properties && typeof event.properties === "object") return event.properties
  return {}
}

export function sessionIDOf(event: unknown): string | undefined {
  const record = readEvent(event)
  if (!record) return undefined
  const id = payload(record).sessionID
  return typeof id === "string" ? id : undefined
}

/** Session title, when the event carries one (`session.renamed`, `session.created`). */
export function sessionTitleOf(event: unknown): string | undefined {
  const record = readEvent(event)
  if (!record) return undefined
  const title = payload(record).title
  return typeof title === "string" && title.trim() !== "" ? title.trim() : undefined
}

/** Event types that announce a session title, so it can be remembered. */
export function announcesTitle(event: unknown): boolean {
  const record = readEvent(event)
  if (!record) return false
  return record.type === SESSION_RENAMED || record.type === SESSION_CREATED
}

/** A subagent session reports a parent that differs from its own id. */
function isSubagent(event: EventLike): boolean {
  const data = payload(event)
  const parent = data.parentID ?? data.parentSessionID
  const self = data.sessionID
  if (typeof parent !== "string") return false
  return typeof self !== "string" || parent !== self
}

export type EventRole = "start" | "notify"

export interface Classified {
  role: EventRole
  kind: EventKind
}

/**
 * Classify an event into a start marker or a notification.
 *
 * Returns `undefined` for events the plugin ignores. Defensive about unknown
 * shapes so an OpenCode change degrades to "no notification" rather than a crash.
 */
export function classifyEvent(event: unknown): Classified | undefined {
  const record = readEvent(event)
  if (!record) return undefined
  const type = record.type as string

  switch (type) {
    case EXECUTION_STARTED:
    case EXECUTION_STARTED_LEGACY:
      return { role: "start", kind: "complete" }

    case SESSION_IDLE:
    case EXECUTION_SUCCEEDED:
      return {
        role: "notify",
        kind: isSubagent(record) ? "subagent_complete" : "complete",
      }

    case EXECUTION_FAILED:
    case SESSION_ERROR:
      return isSubagent(record) ? undefined : { role: "notify", kind: "error" }

    case PERMISSION_ASKED:
      return { role: "notify", kind: "permission" }

    default:
      return undefined
  }
}

export interface RenderContext {
  project?: string
  session?: string
}

/** Fill `{project}` / `{session}` placeholders, dropping empty trailing separators. */
export function renderMessage(template: string, context: RenderContext): string {
  const rendered = template
    .replaceAll("{project}", context.project ?? "")
    .replaceAll("{session}", context.session ?? "")

  return rendered
    .replace(/[\s\u2014\-:|]+$/u, "")
    .replace(/\s{2,}/g, " ")
    .trim()
}
