import { authorizeStatusRequest } from "@/lib/dashboard-auth"
import { getOrchestrator } from "@/lib/orchestrator-singleton"

export function GET(request: Request) {
  const unauthorized = authorizeStatusRequest(request)
  if (unauthorized) return unauthorized

  const orchestrator = getOrchestrator()
  if (!orchestrator) {
    return Response.json({ error: "Orchestrator not initialized" }, { status: 503 })
  }
  return Response.json(orchestrator.getStatus())
}
