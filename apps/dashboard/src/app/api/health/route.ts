import { getOrchestrator } from "@/lib/orchestrator-singleton"

export function GET() {
  const orchestrator = getOrchestrator()

  if (!orchestrator) {
    return Response.json(
      { status: "degraded", reason: "Orchestrator not initialized (UI-only mode)" },
      { status: 503 },
    )
  }

  const state = orchestrator.getStatus() as Record<string, unknown>
  return Response.json({
    status: "ok",
    isRunning: state.isRunning ?? false,
    activeAgents: state.activeAgents ?? 0,
    uptime: process.uptime(),
  })
}
