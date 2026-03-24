import { getOrchestrator } from "@/lib/orchestrator-singleton"
import { env } from "@/lib/env"

export const dynamic = "force-dynamic"

export async function GET() {
  const orchestrator = getOrchestrator()

  let closed = false
  let intervalId: ReturnType<typeof setInterval> | null = null

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()

      const send = (event: string, data: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          cleanup()
        }
      }

      const cleanup = () => {
        closed = true
        if (intervalId) {
          clearInterval(intervalId)
          intervalId = null
        }
        // Unsubscribe event handlers
        if (orchestrator) {
          orchestrator.off("agent.start", onAgentEvent)
          orchestrator.off("agent.done", onAgentEvent)
          orchestrator.off("agent.failed", onAgentEvent)
        }
      }

      // Real-time event handler: push agent events immediately
      const onAgentEvent = (payload: unknown) => {
        if (orchestrator) {
          send("state", orchestrator.getStatus())
        }
      }

      // Send initial state snapshot
      if (orchestrator) {
        send("state", orchestrator.getStatus())

        // Subscribe to real-time orchestrator events
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
          config: { agentType: env.AGENT_TYPE, maxParallel: env.MAX_PARALLEL, serverPort: env.SERVER_PORT },
        })
      }

      send("keepalive", null)

      // Periodic full-state sync as fallback (less frequent since events push real-time updates)
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
      closed = true
      if (intervalId) {
        clearInterval(intervalId)
        intervalId = null
      }
      if (orchestrator) {
        orchestrator.off("agent.start", () => {})
        orchestrator.off("agent.done", () => {})
        orchestrator.off("agent.failed", () => {})
      }
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
