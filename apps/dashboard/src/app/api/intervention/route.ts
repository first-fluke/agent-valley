/**
 * POST /api/intervention — Dashboard → InterventionBus bridge.
 *
 * Body: { attemptId: string, command: InterventionCommand }
 *   InterventionCommand = { kind: "pause" }
 *                       | { kind: "resume" }
 *                       | { kind: "append_prompt", text: string }
 *                       | { kind: "abort", reason: string }
 *
 * Auth: gated by authorizeInterventionRequest (@/lib/dashboard-auth). Local
 *       requests pass a best-effort Host-header check by default; any
 *       non-local request (or SYMPHONY_ALLOW_REMOTE_INTERVENTION=1) requires
 *       a matching `Authorization: Bearer <SYMPHONY_INTERVENTION_TOKEN>`.
 *       See @/lib/dashboard-auth.ts for the full policy and rationale —
 *       the Host header alone is forgeable and is never the sole gate for
 *       non-local traffic.
 *
 * Delegates all decisions to InterventionBus — the handler itself
 * contains no business logic (clean-architecture: Presentation → Application).
 */

import type { InterventionCommand } from "@agent-valley/core/domain/ports/agent-runner"
import { authorizeInterventionRequest } from "@/lib/dashboard-auth"
import { getOrchestrator } from "@/lib/orchestrator-singleton"

export const dynamic = "force-dynamic"

function badRequest(message: string): Response {
  return Response.json({ error: "BadRequest", message }, { status: 400 })
}

function parseCommand(value: unknown): InterventionCommand | { error: string } {
  if (!value || typeof value !== "object") {
    return { error: "command must be an object with a 'kind' field" }
  }
  const c = value as { kind?: unknown; text?: unknown; reason?: unknown }
  switch (c.kind) {
    case "pause":
      return { kind: "pause" }
    case "resume":
      return { kind: "resume" }
    case "append_prompt":
      if (typeof c.text !== "string" || c.text.trim() === "") {
        return { error: "append_prompt requires a non-empty 'text' string" }
      }
      return { kind: "append_prompt", text: c.text }
    case "abort":
      return { kind: "abort", reason: typeof c.reason === "string" ? c.reason : "operator_requested" }
    default:
      return {
        error: `unknown command kind "${String(c.kind)}" — expected pause | resume | append_prompt | abort`,
      }
  }
}

export async function POST(request: Request): Promise<Response> {
  const unauthorized = authorizeInterventionRequest(request)
  if (unauthorized) return unauthorized

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return badRequest("Request body must be valid JSON")
  }

  if (!body || typeof body !== "object") {
    return badRequest("Request body must be a JSON object with { attemptId, command }")
  }
  const { attemptId, command } = body as { attemptId?: unknown; command?: unknown }
  if (typeof attemptId !== "string" || attemptId === "") {
    return badRequest("'attemptId' must be a non-empty string")
  }
  const parsed = parseCommand(command)
  if ("error" in parsed) return badRequest(parsed.error)

  const orchestrator = getOrchestrator()
  if (!orchestrator || !orchestrator.intervention) {
    return Response.json({ error: "Unavailable", message: "Orchestrator not initialized" }, { status: 503 })
  }

  const result = await orchestrator.intervention.send(attemptId, parsed)
  if (result.ok) {
    return Response.json({ ok: true }, { status: 200 })
  }

  const status =
    result.reason === "unknown_attempt"
      ? 404
      : result.reason === "terminated"
        ? 409
        : result.reason === "unsupported"
          ? 422
          : 400
  return Response.json({ ok: false, reason: result.reason, message: result.message }, { status })
}
