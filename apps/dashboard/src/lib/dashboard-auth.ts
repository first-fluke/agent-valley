/**
 * Dashboard auth gate for status/events endpoints.
 *
 * Default policy: only allow requests whose host resolves to localhost.
 * This protects /api/status and /api/events from accidental public exposure
 * when the dashboard is proxied through ngrok (which is on by default for
 * Linear webhook delivery).
 *
 * Escape hatches:
 *   - SYMPHONY_DASHBOARD_TOKEN — require Authorization: Bearer <token> match
 *   - SYMPHONY_ALLOW_REMOTE_STATUS=1 — disable the host gate entirely
 *
 * The /api/webhook route is NOT gated here — it uses HMAC signature verification.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

function isLocalHost(host: string | null): boolean {
  if (!host) return false
  // Host header may include a port ("localhost:3000"). Strip it.
  const hostname = host.replace(/:\d+$/, "")
  return LOCAL_HOSTS.has(hostname)
}

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Returns null if the request is allowed, or a 401/403 Response otherwise.
 */
export function authorizeStatusRequest(request: Request): Response | null {
  if (process.env.SYMPHONY_ALLOW_REMOTE_STATUS === "1") return null

  if (isLocalHost(request.headers.get("host"))) return null

  const expected = process.env.SYMPHONY_DASHBOARD_TOKEN
  if (expected) {
    const header = request.headers.get("authorization") ?? ""
    const match = /^Bearer\s+(.+)$/.exec(header)
    if (match && timingSafeEqualString(match[1], expected)) return null
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }

  return Response.json(
    {
      error: "Forbidden",
      message:
        "Dashboard status endpoints are localhost-only by default. " +
        "Set SYMPHONY_DASHBOARD_TOKEN to require a bearer token for remote access, " +
        "or SYMPHONY_ALLOW_REMOTE_STATUS=1 to disable this gate entirely.",
    },
    { status: 403 },
  )
}
