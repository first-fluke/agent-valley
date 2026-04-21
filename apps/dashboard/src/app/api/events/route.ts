import { authorizeStatusRequest } from "@/lib/dashboard-auth"
import { toOrchestratorConfig } from "@/lib/env"
import { getOrchestrator } from "@/lib/orchestrator-singleton"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const unauthorized = authorizeStatusRequest(request)
  if (unauthorized) return unauthorized

  const orchestrator = getOrchestrator()

  let closed = false
  let intervalId: ReturnType<typeof setInterval> | null = null
  const onAgentEvent = (_payload: unknown) => {
    if (orchestrator) {
      send("state", orchestrator.getStatus())
    }
  }

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
    if (orchestrator) {
      orchestrator.off("agent.start", onAgentEvent)
      orchestrator.off("agent.done", onAgentEvent)
      orchestrator.off("agent.failed", onAgentEvent)
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller

      if (orchestrator) {
        send("state", orchestrator.getStatus())
        orchestrator.on("agent.start", onAgentEvent)
        orchestrator.on("agent.done", onAgentEvent)
        orchestrator.on("agent.failed", onAgentEvent)
      } else {
        send("state", {
          isRunning: false,
          lastEventAt: null,
          activeWorkspaces: [],
          activeAgents: 0,
          retryQueueSize: 0,
          config: (() => {
            try {
              const c = toOrchestratorConfig()
              return { agentType: c.agentType, maxParallel: c.maxParallel, serverPort: c.serverPort }
            } catch {
              return {}
            }
          })(),
        })
      }

      send("keepalive", null)

      intervalId = setInterval(() => {
        if (closed) {
          cleanup()
          return
        }
        if (orchestrator) {
          send("state", orchestrator.getStatus())
        }
      }, 5000)
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
