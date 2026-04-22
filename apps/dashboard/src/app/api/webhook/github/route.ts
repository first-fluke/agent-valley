import { getOrchestrator } from "@/lib/orchestrator-singleton"

/**
 * GitHub webhook receiver — mirrors /api/webhook structure, reads the
 * signature from `X-Hub-Signature-256`. The Orchestrator uses the injected
 * WebhookReceiver to verify the signature, so this handler contains no
 * tracker-specific logic.
 */
export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? ""
  if (!contentType.includes("application/json")) {
    return Response.json({ error: "Unsupported content type. Expected application/json" }, { status: 415 })
  }

  const payload = await request.text()
  if (payload.length > 1_048_576) {
    return Response.json({ error: "Payload too large" }, { status: 413 })
  }

  const signature = request.headers.get("x-hub-signature-256") ?? request.headers.get("X-Hub-Signature-256") ?? ""

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
