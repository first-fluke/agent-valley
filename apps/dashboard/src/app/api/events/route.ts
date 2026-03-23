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
          cleanup()
        }
      }

      const cleanup = () => {
        closed = true
        if (intervalId) {
          clearInterval(intervalId)
          intervalId = null
        }
      }

      // Send initial state snapshot
      if (orchestrator) {
        send("state", orchestrator.getStatus())
      } else {
        const mem = process.memoryUsage()
        const cpu = process.cpuUsage()
        send("state", {
          isRunning: false,
          lastEventAt: null,
          activeWorkspaces: [],
          activeAgents: 0,
          retryQueueSize: 0,
          config: { agentType: env.AGENT_TYPE, maxParallel: env.MAX_PARALLEL, serverPort: env.SERVER_PORT },
          systemMetrics: {
            memoryRss: mem.rss,
            memoryHeapUsed: mem.heapUsed,
            memoryHeapTotal: mem.heapTotal,
            cpuUser: cpu.user,
            cpuSystem: cpu.system,
            uptime: process.uptime(),
          },
        })
      }

      send("keepalive", null)

      // Poll for state changes
      intervalId = setInterval(() => {
        if (closed) {
          cleanup()
          return
        }
        if (orchestrator) {
          send("state", orchestrator.getStatus())
        }
      }, 2000)
    },
    cancel() {
      closed = true
      if (intervalId) {
        clearInterval(intervalId)
        intervalId = null
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
