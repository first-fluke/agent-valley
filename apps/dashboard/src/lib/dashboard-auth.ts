/**
 * Dashboard auth gate — status/events/intervention endpoints.
 *
 * SECURITY NOTE: The `Host` request header is attacker-controlled and must
 * never be treated as a trustworthy identity signal by itself — anyone who
 * can reach the bound port directly can send `curl -H 'Host: localhost'`
 * from anywhere. Next.js Route Handlers have no access to the underlying
 * socket's remote address, so there is no way to verify "this connection
 * physically originated on this machine" from inside the handler.
 *
 * Local-request detection below (`isLikelyLocalRequest`) is therefore a
 * BEST-EFFORT convenience for the default single-node dev setup only. It is
 * NOT a security boundary and MUST NEVER be allowed to override a
 * configured bearer token: if a token is set, it is checked for every
 * request regardless of the `Host` header, because a `Host: localhost`
 * header can be forged by any caller that can reach the bound port (see
 * apps/cli/src/supervisor.ts — the dashboard binds `0.0.0.0` by default).
 * The real access control is the bearer token:
 *   - SYMPHONY_DASHBOARD_TOKEN     — for /api/status and /api/events
 *   - SYMPHONY_INTERVENTION_TOKEN  — for /api/intervention
 * The local-request heuristic is used only as a dev-convenience fallback
 * when NO token is configured at all. Once the corresponding
 * SYMPHONY_ALLOW_REMOTE_* flag is enabled, the token becomes mandatory
 * (fail-closed) — remote access is never granted without one.
 */

import { createHash, timingSafeEqual } from "node:crypto"

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])
const LOOPBACK_IPS = new Set(["127.0.0.1", "::1"])

function isLocalHostHeader(host: string | null): boolean {
  if (!host) return false
  // Host header may include a port ("localhost:3000"). Strip it.
  const hostname = host.replace(/:\d+$/, "")
  return LOCAL_HOSTS.has(hostname)
}

/**
 * Best-effort local-request heuristic. Host header alone is forgeable, so
 * this additionally requires that there is no `X-Forwarded-For` header, or
 * that its first hop is a loopback address. A reverse proxy (e.g. ngrok,
 * which fronts this dashboard by default — see AGENTS.md) sets
 * `X-Forwarded-For` for tunnelled traffic, so its presence with a
 * non-loopback value reveals that the request did not originate on this
 * machine even when `Host` was spoofed to "localhost". This narrows — but
 * does not eliminate — the dev-convenience default path; it is not a
 * substitute for the bearer token (see module doc above).
 */
function isLikelyLocalRequest(request: Request): boolean {
  if (!isLocalHostHeader(request.headers.get("host"))) return false
  const forwardedFor = request.headers.get("x-forwarded-for")
  if (!forwardedFor) return true
  const firstHop = forwardedFor.split(",")[0]?.trim()
  return firstHop ? LOOPBACK_IPS.has(firstHop) : false
}

/**
 * Constant-time string comparison. Both inputs are SHA-256 hashed to a
 * fixed-length (32-byte) digest before comparing, so there is no length
 * branch to leak timing — `crypto.timingSafeEqual` requires equal-length
 * buffers, which hashing guarantees regardless of the original input
 * lengths. Mirrors the pattern in
 * `packages/core/src/tracker/hmac-verify.ts` (kept local to avoid an
 * app→package import across the dashboard boundary for a two-line helper).
 */
function timingSafeEqualString(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest()
  const digestB = createHash("sha256").update(b).digest()
  return timingSafeEqual(digestA, digestB)
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? ""
  const match = /^Bearer\s+(.+)$/.exec(header)
  return match ? match[1] : null
}

function unauthorized(tokenEnvVar: string): Response {
  return Response.json(
    {
      error: "Unauthorized",
      message: `Provide 'Authorization: Bearer <token>' matching the ${tokenEnvVar} environment variable.`,
    },
    { status: 401 },
  )
}

interface GateOptions {
  /** Env var name that opts the endpoint into remote access, e.g. "SYMPHONY_ALLOW_REMOTE_STATUS". */
  allowRemoteEnvVar: string
  /** Env var name holding the shared-secret bearer token, e.g. "SYMPHONY_DASHBOARD_TOKEN". */
  tokenEnvVar: string
  /** Human-readable endpoint name used in error messages, e.g. "/api/intervention". */
  endpointLabel: string
}

/**
 * Returns null if the request is allowed, or a 401/403 Response otherwise.
 *
 * Policy (checked in this order — a configured token can NEVER be
 * bypassed by the Host-header heuristic, spoofed or not):
 *  1. If the remote-allow flag is set, a matching bearer token is REQUIRED.
 *     If the flag is set but no token is configured, ALL requests are
 *     rejected — unauthenticated remote access is never permitted.
 *  2. Otherwise, if a token IS configured, it is REQUIRED for every
 *     request, local-looking or not. This closes the bypass where a
 *     forged `Host: localhost` header (trivial for anyone who can reach
 *     the bound port — see module doc) would otherwise skip the token
 *     check entirely.
 *  3. Otherwise (no token configured at all), requests that look local
 *     (best-effort — see module doc) are allowed through for zero-config
 *     dev convenience.
 *  4. Otherwise, the request is rejected as localhost-only.
 */
function authorizeGatedRequest(request: Request, options: GateOptions): Response | null {
  const remoteEnabled = process.env[options.allowRemoteEnvVar] === "1"
  const token = process.env[options.tokenEnvVar]

  if (remoteEnabled) {
    if (!token) {
      return Response.json(
        {
          error: "Forbidden",
          message:
            `${options.allowRemoteEnvVar}=1 enables remote access to ${options.endpointLabel}, but ` +
            `${options.tokenEnvVar} is not set. Set ${options.tokenEnvVar} to a strong random value ` +
            "in your environment before enabling remote access — unauthenticated remote access is never allowed.",
        },
        { status: 403 },
      )
    }
    const supplied = bearerToken(request)
    if (supplied && timingSafeEqualString(supplied, token)) return null
    return unauthorized(options.tokenEnvVar)
  }

  if (token) {
    const supplied = bearerToken(request)
    if (supplied && timingSafeEqualString(supplied, token)) return null
    return unauthorized(options.tokenEnvVar)
  }

  if (isLikelyLocalRequest(request)) return null

  return Response.json(
    {
      error: "Forbidden",
      message:
        `${options.endpointLabel} is localhost-only by default (best-effort Host-header check — not a ` +
        `security boundary). Set ${options.tokenEnvVar} to require a bearer token for remote access, or ` +
        `set both ${options.tokenEnvVar} and ${options.allowRemoteEnvVar}=1 to allow remote access explicitly.`,
    },
    { status: 403 },
  )
}

/** Auth gate for /api/status and /api/events. */
export function authorizeStatusRequest(request: Request): Response | null {
  return authorizeGatedRequest(request, {
    allowRemoteEnvVar: "SYMPHONY_ALLOW_REMOTE_STATUS",
    tokenEnvVar: "SYMPHONY_DASHBOARD_TOKEN",
    endpointLabel: "Dashboard status endpoints",
  })
}

/** Auth gate for /api/intervention. */
export function authorizeInterventionRequest(request: Request): Response | null {
  return authorizeGatedRequest(request, {
    allowRemoteEnvVar: "SYMPHONY_ALLOW_REMOTE_INTERVENTION",
    tokenEnvVar: "SYMPHONY_INTERVENTION_TOKEN",
    endpointLabel: "/api/intervention",
  })
}
