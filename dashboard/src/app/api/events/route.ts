import { getOrchestrator } from "@/lib/orchestrator-singleton"

export const dynamic = "force-dynamic"

export async function GET() {
  const orchestrator = getOrchestrator()

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()

      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
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
          config: { agentType: "claude", maxParallel: 3, serverPort: 3000 },
        })
      }

      // Poll for state changes
      const interval = setInterval(() => {
        if (orchestrator) {
          send("state", orchestrator.getStatus())
        }
      }, 2000)

      // Cleanup on close
      const cleanup = () => {
        clearInterval(interval)
      }

      // AbortSignal is not directly available on ReadableStream controller
      // The stream will be cleaned up when the client disconnects
      controller.enqueue(encoder.encode(": keepalive\n\n"))

      // Store cleanup for cancel
      ;(controller as unknown as { _cleanup: () => void })._cleanup = cleanup
    },
    cancel(controller) {
      const ctrl = controller as unknown as { _cleanup?: () => void }
      ctrl._cleanup?.()
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
