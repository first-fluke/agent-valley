import { getOrchestrator } from "@/lib/orchestrator-singleton"

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? ""
  if (!contentType.includes("application/json")) {
    return Response.json(
      { error: "Unsupported content type. Expected application/json" },
      { status: 415 },
    )
  }

  const payload = await request.text()

  if (payload.length > 1_048_576) {
    return Response.json({ error: "Payload too large" }, { status: 413 })
  }

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
