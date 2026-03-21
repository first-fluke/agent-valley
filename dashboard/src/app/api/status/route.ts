import { getOrchestrator } from "@/lib/orchestrator-singleton"

export function GET() {
  const orchestrator = getOrchestrator()
  if (!orchestrator) {
    return Response.json({ error: "Orchestrator not initialized" }, { status: 503 })
  }
  return Response.json(orchestrator.getStatus())
}
