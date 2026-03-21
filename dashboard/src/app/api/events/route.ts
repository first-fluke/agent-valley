import { getOrchestrator } from "@/lib/orchestrator-singleton"
import { env } from "@/lib/env"

export const dynamic = "force-dynamic"

export async function GET() {
  const orchestrator = getOrchestrator()

  let intervalId: ReturnType<typeof setInterval> | null = null
  let closed = false

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()

      const send = (event: string, data: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          // Controller closed — clean up
          closed = true
          if (intervalId) clearInterval(intervalId)
        }
      }

      // Send initial state snapshot
      if (orchestrator) {
        send("state", orchestrator.getStatus())
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

      // Poll for state changes
      intervalId = setInterval(() => {
        if (orchestrator) {
          send("state", orchestrator.getStatus())
        }
      }, 2000)
    },
    cancel() {
      closed = true
      if (intervalId) clearInterval(intervalId)
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
