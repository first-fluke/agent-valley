import { getOrchestrator } from "@/lib/orchestrator-singleton"

export function GET() {
  const orchestrator = getOrchestrator()

  if (!orchestrator) {
    return Response.json(
      {
        status: "degraded",
        isRunning: false,
        reason: "Orchestrator not initialized. Run av doctor and inspect the server startup log.",
      },
      { status: 503 },
    )
  }

  const state = orchestrator.getStatus() as Record<string, unknown>
  const running = state.isRunning === true
  return Response.json(
    {
      status: running ? "ok" : "degraded",
      ...(running ? {} : { reason: "Orchestrator is stopped. Restart av up to resume processing issues." }),
      isRunning: state.isRunning ?? false,
      activeAgents: state.activeAgents ?? 0,
      uptime: process.uptime(),
    },
    { status: running ? 200 : 503 },
  )
}
