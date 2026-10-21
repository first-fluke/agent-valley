import { getOrchestrator } from "@/lib/orchestrator-singleton"
import { readBoundedBody } from "@/lib/request-body"

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? ""
  if (!contentType.includes("application/json")) {
    return Response.json({ error: "Unsupported content type. Expected application/json" }, { status: 415 })
  }

  const body = await readBoundedBody(request)
  if (!body.ok) {
    return Response.json({ error: "Payload too large" }, { status: body.status })
  }
  const payload = body.text

  const signature = request.headers.get("linear-signature") ?? ""

  const orchestrator = getOrchestrator()
  if (!orchestrator) {
    return Response.json({ error: "Orchestrator not initialized" }, { status: 503 })
  }

  const result = await orchestrator.handleWebhook(payload, signature)
  return new Response(result.body, {
    status: result.status,
    headers: { "Content-Type": "application/json" },
  })
}
