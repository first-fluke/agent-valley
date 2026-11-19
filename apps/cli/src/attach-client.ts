/**
 * Dashboard API client for `av attach`: follow an issue thread over SSE and
 * send intervention commands. Presentation-side plumbing only — every
 * decision about a command stays in the orchestrator's InterventionBus.
 */

import type { ThreadBacklog, ThreadUpdate } from "@agent-valley/core/domain/issue-thread"
import type { InterventionCommand } from "@agent-valley/core/domain/ports/agent-runner"
import { dashboardUrl } from "./status-client"

type FetchLike = typeof fetch

/** A dashboard response that retrying will not fix (auth, bad request). */
export class DashboardRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "DashboardRequestError"
  }
}

// ── Active attempts (from /api/status) ────────────────────────────────

export interface ActiveIssue {
  issueKey: string
  attemptId?: string
  agentType?: string
}

/** Issues the orchestrator is working on right now, from an /api/status body. */
export function listActiveIssues(status: Record<string, unknown>): ActiveIssue[] {
  const workspaces = Array.isArray(status.activeWorkspaces) ? status.activeWorkspaces : []
  return workspaces.flatMap((workspace): ActiveIssue[] => {
    if (!workspace || typeof workspace !== "object") return []
    const { key, attemptId, agentType } = workspace as Record<string, unknown>
    if (typeof key !== "string" || !key) return []
    return [
      {
        issueKey: key,
        attemptId: typeof attemptId === "string" && attemptId ? attemptId : undefined,
        agentType: typeof agentType === "string" && agentType ? agentType : undefined,
      },
    ]
  })
}

/** Match an issue key the way people type it: case-insensitively. */
export function findActiveIssue(status: Record<string, unknown>, issueKey: string): ActiveIssue | undefined {
  const wanted = issueKey.toLowerCase()
  return listActiveIssues(status).find((issue) => issue.issueKey.toLowerCase() === wanted)
}

// ── SSE parsing ───────────────────────────────────────────────────────

export interface SseEvent {
  event: string
  data: string
}

/** Incremental `text/event-stream` parser. Feed decoded text; complete events are emitted. */
export function createSseParser(onEvent: (event: SseEvent) => void): (chunk: string) => void {
  let buffer = ""
  let event = ""
  let data: string[] = []

  const dispatch = () => {
    if (data.length > 0) onEvent({ event: event || "message", data: data.join("\n") })
    event = ""
    data = []
  }

  return (chunk) => {
    buffer += chunk
    let newline = buffer.indexOf("\n")
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "")
      buffer = buffer.slice(newline + 1)
      if (line === "") dispatch()
      else if (line.startsWith("event:")) event = line.slice(6).trim()
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
      // Comment lines (":keepalive") and other fields are ignored.
      newline = buffer.indexOf("\n")
    }
  }
}

// ── Thread stream ─────────────────────────────────────────────────────

export interface ThreadStreamHandlers {
  onBacklog(backlog: ThreadBacklog): void
  onUpdate(update: ThreadUpdate): void
  onUnavailable(message: string): void
}

/**
 * Follow `/api/thread` until the server closes the stream or `signal` aborts.
 * Throws DashboardRequestError when the dashboard refuses the request.
 */
export async function followThread(
  port: string,
  issueKey: string,
  handlers: ThreadStreamHandlers,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const token = process.env.SYMPHONY_DASHBOARD_TOKEN
  let response: Response
  try {
    response = await fetchImpl(dashboardUrl(port, `/api/thread?issue=${encodeURIComponent(issueKey)}`), {
      headers: { Accept: "text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal,
    })
  } catch (error) {
    if (signal.aborted) return
    throw error
  }

  if (!response.ok || !response.body) {
    const detail = await readMessage(response)
    if (response.status === 401 || response.status === 403) {
      throw new DashboardRequestError(
        `Dashboard denied the thread stream (${response.status}). Set SYMPHONY_DASHBOARD_TOKEN in your environment to match the dashboard process.${detail}`,
        response.status,
      )
    }
    throw new DashboardRequestError(
      `Thread stream request failed (${response.status}). Check that this av version matches the running dashboard, then restart it with av down && av up.${detail}`,
      response.status,
    )
  }

  const parse = createSseParser(({ event, data }) => {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      return // A malformed frame carries nothing to show.
    }
    if (event === "backlog") handlers.onBacklog(payload as ThreadBacklog)
    else if (event === "entry") handlers.onUpdate(payload as ThreadUpdate)
    else if (event === "unavailable") handlers.onUnavailable(String((payload as { message?: unknown })?.message ?? ""))
  })

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return
      parse(decoder.decode(value, { stream: true }))
    }
  } catch (error) {
    if (signal.aborted) return
    throw error
  }
}

// ── Intervention ──────────────────────────────────────────────────────

export type InterventionOutcome = { ok: true } | { ok: false; message: string }

/** POST one command to `/api/intervention` for the given attempt. */
export async function sendIntervention(
  port: string,
  attemptId: string,
  command: InterventionCommand,
  fetchImpl: FetchLike = fetch,
): Promise<InterventionOutcome> {
  const token = process.env.SYMPHONY_INTERVENTION_TOKEN
  const url = dashboardUrl(port, "/api/intervention")
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Without a token the endpoint accepts local same-origin callers only.
        Origin: new URL(url).origin,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ attemptId, command }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    return {
      ok: false,
      message: `Could not reach the dashboard (${error instanceof Error ? error.message : String(error)}). Check that av up is running.`,
    }
  }
  if (response.ok) return { ok: true }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      message: `Dashboard denied the command (${response.status}). Set SYMPHONY_INTERVENTION_TOKEN in your environment to match the dashboard process.${await readMessage(response)}`,
    }
  }
  const detail = await readMessage(response)
  return { ok: false, message: detail.trim() || `Command failed (${response.status}).` }
}

/** The server's own explanation, prefixed with a space so it can trail a sentence. */
async function readMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown }
    return typeof body.message === "string" && body.message ? ` ${body.message}` : ""
  } catch {
    return ""
  }
}
