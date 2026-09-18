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
    title: "Session complete",
    message: "{project} — {session}",
  },
  error: {
    enabled: true,
    title: "Session error",
    message: "{project} — {session}",
  },
  permission: {
    enabled: true,
    title: "Waiting for permission",
    message: "{project} — {session}",
  },
  subagent_complete: {
    enabled: false,
    title: "Subagent finished",
    message: "{project}",
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
  location?: Record<string, unknown>
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

/** Parent session id when the event names one (`session.created`). */
export function sessionParentOf(event: unknown): string | undefined {
  const record = readEvent(event)
  if (!record) return undefined
  const data = payload(record)
  const parent = data.parentID ?? data.parentSessionID
  if (typeof parent !== "string" || parent === "") return undefined
  const self = data.sessionID
  return self === parent ? undefined : parent
}

/** Project id carried in an event payload (`session.created`, `session.moved`). */
export function sessionProjectOf(event: unknown): string | undefined {
  const record = readEvent(event)
  if (!record) return undefined
  const projectID = payload(record).projectID
  return typeof projectID === "string" && projectID !== "" ? projectID : undefined
}

/** Location directory carried in an event payload (`session.created`, `session.moved`). */
export function sessionLocationOf(event: unknown): string | undefined {
  const record = readEvent(event)
  if (!record) return undefined
  const location = payload(record).location
  if (!location || typeof location !== "object") return undefined
  const directory = (location as { directory?: unknown }).directory
  return typeof directory === "string" && directory !== "" ? directory : undefined
}

/** Location directory carried on the event envelope, when present. */
export function eventLocationOf(event: unknown): string | undefined {
  const directory = readEvent(event)?.location?.directory
  return typeof directory === "string" && directory !== "" ? directory : undefined
}

/**
 * Whether an event belongs to the plugin's own location.
 *
 * OpenCode delivers events to every location in the instance, so a plugin
 * loaded once per project would otherwise toast N times, once per project.
 * Events without a location stay eligible for compatibility.
 */
export function matchesLocation(event: unknown, directory?: string): boolean {
  if (!directory) return true
  const eventDirectory = eventLocationOf(event)
  return eventDirectory === undefined || eventDirectory === directory
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

/** Last path segment, tolerant of both POSIX and Windows separators. */
function lastPathSegment(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "")
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return index >= 0 ? trimmed.slice(index + 1) : trimmed
}

export interface ProjectLike {
  id?: string
  directory?: string
  canonical?: string
}

/**
 * Human-readable project label.
 *
 * `ctx.location.project.id` is an opaque hash, so prefer the folder name of the
 * project root and only fall back to the raw id when no usable directory is known.
 */
export function projectLabel(project?: ProjectLike, directory?: string): string | undefined {
  const candidates = [project?.canonical, project?.directory, directory]

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue
    const name = lastPathSegment(candidate.trim())
    if (name !== "") return name
  }

  return typeof project?.id === "string" && project.id !== "" ? project.id : undefined
}

/**
 * Session label: the title when known, otherwise a short id so the toast still
 * identifies which session it refers to.
 */
export function sessionLabel(title: string | undefined, sessionID: string | undefined): string | undefined {
  const trimmed = title?.trim()
  if (trimmed) return trimmed
  return sessionID ? sessionID.slice(0, 8) : undefined
}

/** Per-session bookkeeping that coalesces one execution into one notification. */
export interface TurnState {
  startedAt?: number
  notified: boolean
}

/** Begin a new execution for a session, resetting per-turn dedupe state. */
export function beginTurn(turns: Map<string, TurnState>, key: string, now: number = Date.now()): void {
  turns.set(key, { startedAt: now, notified: false })
}

/**
 * Claim the completion of an execution.
 *
 * Returns `claimed: false` when this execution has already produced a
 * notification, which coalesces the paired `session.execution.succeeded` and
 * deprecated `session.idle` events (and replayed events) into a single toast.
 */
export function claimCompletion(
  turns: Map<string, TurnState>,
  key: string,
): { claimed: boolean; startedAt?: number } {
  const turn = turns.get(key)
  if (turn?.notified) return { claimed: false, startedAt: turn.startedAt }

  turns.set(key, { startedAt: turn?.startedAt, notified: true })
  return { claimed: true, startedAt: turn?.startedAt }
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
