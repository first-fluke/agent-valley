import {
  clearSessionCookie,
  sameOrigin,
  sessionCookie,
  sessionState,
  tokenConfigured,
  validToken,
} from "@/lib/dashboard-auth"

export const dynamic = "force-dynamic"

export function GET(request: Request): Response {
  return Response.json(sessionState(request), { headers: { "Cache-Control": "no-store" } })
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return Response.json({ error: "Forbidden", message: "Origin must match this dashboard." }, { status: 403 })
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: "BadRequest", message: "Expected JSON credentials." }, { status: 400 })
  }
  if (!body || typeof body !== "object") return Response.json({ error: "BadRequest" }, { status: 400 })
  const { statusToken, interventionToken } = body as Record<string, unknown>
  if ((statusToken !== undefined && typeof statusToken !== "string") ||
      (interventionToken !== undefined && typeof interventionToken !== "string")) {
    return Response.json({ error: "BadRequest", message: "Tokens must be strings." }, { status: 400 })
  }
  const scopes = [
    { scope: "status" as const, token: statusToken },
    { scope: "intervention" as const, token: interventionToken },
  ]
  for (const { scope, token } of scopes) {
    if (tokenConfigured(scope) && typeof token === "string" && !validToken(scope, token)) {
      return Response.json({ error: "Unauthorized", message: "Invalid token." }, { status: 401 })
    }
  }
  const response = Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } })
  for (const { scope, token } of scopes) {
    if (tokenConfigured(scope) && typeof token === "string" && validToken(scope, token)) {
      response.headers.append("Set-Cookie", sessionCookie(scope, request))
    }
  }
  return response
}

export function DELETE(request: Request): Response {
  if (!sameOrigin(request)) return Response.json({ error: "Forbidden" }, { status: 403 })
  const response = Response.json({ ok: true })
  response.headers.append("Set-Cookie", clearSessionCookie("status"))
  response.headers.append("Set-Cookie", clearSessionCookie("intervention"))
  return response
}
