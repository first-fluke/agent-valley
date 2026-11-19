/**
 * GET /api/thread?issue=<issue key> — live issue thread as Server-Sent Events.
 *
 * Events:
 *   backlog      { issueKey, entries }   everything retained, sent on connect
 *                                        and again after an orchestrator reload
 *   entry        ThreadUpdate            a new entry, or text appended to one
 *   unavailable  { message }             the orchestrator is not running
 *   keepalive    null
 *
 * Auth: same scope as /api/status and /api/events (dashboard-auth "status").
 * The handler only forwards what the orchestrator's thread store holds.
 */

import type { ThreadBacklog } from "@agent-valley/core/domain/issue-thread"
import { authorizeStatusRequest } from "@/lib/dashboard-auth"
import { getOrchestrator, type OrchestratorInstance } from "@/lib/orchestrator-singleton"

export const dynamic = "force-dynamic"

const MAX_ISSUE_KEY_LENGTH = 200
const KEEPALIVE_MS = 15_000

export async function GET(request: Request) {
  const unauthorized = authorizeStatusRequest(request)
  if (unauthorized) return unauthorized

  const issueKey = new URL(request.url).searchParams.get("issue")?.trim() ?? ""
  if (!issueKey || issueKey.length > MAX_ISSUE_KEY_LENGTH) {
    return Response.json(
      {
        error: "BadRequest",
        message: `Query parameter 'issue' must be an issue key of 1-${MAX_ISSUE_KEY_LENGTH} characters, for example /api/thread?issue=PROJ-12.`,
      },
      { status: 400 },
    )
  }

  // `undefined` = not bound yet; `null` = bound to "no orchestrator".
  let bound: OrchestratorInstance | null | undefined
  let unsubscribe: (() => void) | null = null
  let closed = false
  let intervalId: ReturnType<typeof setInterval> | null = null
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null
  const encoder = new TextEncoder()

  const send = (event: string, data: unknown) => {
    if (closed || !controllerRef) return
    try {
      controllerRef.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
    } catch {
      cleanup()
    }
  }

  const cleanup = () => {
    if (closed) return
    closed = true
    if (intervalId) {
      clearInterval(intervalId)
      intervalId = null
    }
    unsubscribe?.()
    unsubscribe = null
    request.signal.removeEventListener("abort", onAbort)
  }

  const onAbort = () => {
    cleanup()
    controllerRef?.close()
  }

  /** (Re)attach to the current orchestrator; a hot reload replaces the instance. */
  function bind() {
    if (closed) return
    const current = getOrchestrator()
    if (current === bound) return
    unsubscribe?.()
    unsubscribe = null
    bound = current
    const threads = current?.threads
    if (!threads) {
      send("unavailable", {
        message:
          "Orchestrator is unavailable. Run av doctor in the project directory, fix the reported settings.yaml or av.yaml errors, and restart av up.",
      })
      return
    }
    unsubscribe = threads.subscribe(issueKey, (update) => send("entry", update))
    const backlog: ThreadBacklog = { issueKey, entries: threads.read(issueKey) }
    send("backlog", backlog)
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller
      if (request.signal.aborted) {
        onAbort()
        return
      }
      request.signal.addEventListener("abort", onAbort, { once: true })
      bind()
      if (closed) return
      intervalId = setInterval(() => {
        bind()
        send("keepalive", null)
      }, KEEPALIVE_MS)
    },
    cancel() {
      cleanup()
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  })
}
