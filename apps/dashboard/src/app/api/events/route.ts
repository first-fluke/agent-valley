import { authorizeStatusRequest } from "@/lib/dashboard-auth"
import { getOrchestrator, type OrchestratorInstance } from "@/lib/orchestrator-singleton"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const unauthorized = authorizeStatusRequest(request)
  if (unauthorized) return unauthorized

  let orchestrator: OrchestratorInstance | null = null

  let closed = false
  let intervalId: ReturnType<typeof setInterval> | null = null
  const onAgentEvent = () => refresh()
  const onInterventionEvent = (eventName: string) => (payload: unknown) => {
    send(eventName, payload)
    refresh()
  }
  const onPaused = onInterventionEvent("agent.paused")
  const onResumed = onInterventionEvent("agent.resumed")
  const onPromptAppended = onInterventionEvent("agent.prompt_appended")
  const onAborted = onInterventionEvent("agent.aborted")
  const listeners = [
    ["agent.start", onAgentEvent],
    ["agent.done", onAgentEvent],
    ["agent.failed", onAgentEvent],
    ["agent.paused", onPaused],
    ["agent.resumed", onResumed],
    ["agent.prompt_appended", onPromptAppended],
    ["agent.aborted", onAborted],
  ] as const

  const encoder = new TextEncoder()
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null

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
    for (const [event, handler] of listeners) orchestrator?.off(event, handler)
    request.signal.removeEventListener("abort", onAbort)
  }

  const onAbort = () => {
    cleanup()
    controllerRef?.close()
  }

  function refresh() {
    if (closed) return
    const current = getOrchestrator()
    if (current !== orchestrator) {
      for (const [event, handler] of listeners) orchestrator?.off(event, handler)
      orchestrator = current
      for (const [event, handler] of listeners) orchestrator?.on(event, handler)
    }
    if (orchestrator) {
      send("state", orchestrator.getStatus())
    } else {
      send("unavailable", {
        message:
          "Orchestrator is unavailable. Run av doctor in the project directory, fix the reported settings.yaml or av.yaml errors, and restart av up. Check the server log for the startup error.",
      })
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller

      if (request.signal.aborted) {
        onAbort()
        return
      }
      request.signal.addEventListener("abort", onAbort, { once: true })
      refresh()

      send("keepalive", null)

      if (!closed) intervalId = setInterval(refresh, 5000)
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
