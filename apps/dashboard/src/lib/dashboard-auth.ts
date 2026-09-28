import { createHash, createHmac, timingSafeEqual } from "node:crypto"

type Scope = "status" | "intervention"
const CONFIG: Record<Scope, { token: string; remote: string; cookie: string }> = {
  status: { token: "SYMPHONY_DASHBOARD_TOKEN", remote: "SYMPHONY_ALLOW_REMOTE_STATUS", cookie: "av_status_session" },
  intervention: { token: "SYMPHONY_INTERVENTION_TOKEN", remote: "SYMPHONY_ALLOW_REMOTE_INTERVENTION", cookie: "av_intervention_session" },
}
const SESSION_SECONDS = 8 * 60 * 60
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

function equal(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest())
}

function localRequest(request: Request): boolean {
  const host = request.headers.get("host")?.replace(/:\d+$/, "")
  if (!host || !LOCAL_HOSTS.has(host)) return false
  const forwarded = request.headers.get("x-forwarded-for")
  return !forwarded || ["127.0.0.1", "::1"].includes(forwarded.split(",")[0]?.trim() ?? "")
}

function bearer(request: Request): string | null {
  return /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? null
}

function cookie(request: Request, name: string): string | null {
  const value = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))
  return value?.slice(name.length + 1) ?? null
}

function signature(scope: Scope, expiration: string, secret: string): string {
  return createHmac("sha256", secret).update(`${scope}:${expiration}`).digest("hex")
}

function validSession(request: Request, scope: Scope, secret: string): boolean {
  const value = cookie(request, CONFIG[scope].cookie)
  if (!value) return false
  const match = /^(\d{10})\.([a-f0-9]{64})$/.exec(value)
  if (!match || Number(match[1]) <= Math.floor(Date.now() / 1000)) return false
  return equal(match[2], signature(scope, match[1], secret))
}

export function sessionCookie(scope: Scope, request: Request): string {
  const secret = process.env[CONFIG[scope].token]
  if (!secret) throw new Error(`${CONFIG[scope].token} must be configured before issuing a session`)
  const expiration = String(Math.floor(Date.now() / 1000) + SESSION_SECONDS)
  const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https"
    ? "; Secure"
    : ""
  return `${CONFIG[scope].cookie}=${expiration}.${signature(scope, expiration, secret)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}${secure}`
}

export function clearSessionCookie(scope: Scope): string {
  return `${CONFIG[scope].cookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
}

export function tokenConfigured(scope: Scope): boolean {
  return Boolean(process.env[CONFIG[scope].token])
}

export function validToken(scope: Scope, supplied: string): boolean {
  const secret = process.env[CONFIG[scope].token]
  return Boolean(secret && supplied && equal(secret, supplied))
}

export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin")
  const host = request.headers.get("host")
  if (!origin || !host) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host === host && !parsed.username && !parsed.password
  } catch {
    return false
  }
}

export function sessionState(request: Request): Record<Scope, { required: boolean; authenticated: boolean }> {
  return {
    status: { required: tokenConfigured("status"), authenticated: authorizeStatusRequest(request) === null },
    intervention: { required: tokenConfigured("intervention"), authenticated: authorizeInterventionRequest(request) === null },
  }
}

function authorize(request: Request, scope: Scope): Response | null {
  const cfg = CONFIG[scope]
  const secret = process.env[cfg.token]
  if (!secret && process.env[cfg.remote] === "1") {
    return Response.json({ error: "Forbidden", message: `${cfg.remote}=1 requires ${cfg.token}. Set ${cfg.token} before enabling remote access.` }, { status: 403 })
  }
  if (secret) {
    const supplied = bearer(request)
    if ((supplied && equal(supplied, secret)) || validSession(request, scope, secret)) return null
    return Response.json({ error: "Unauthorized", message: `Log in to the dashboard or provide Authorization: Bearer <${cfg.token}>.` }, { status: 401 })
  }
  if (localRequest(request)) return null
  return Response.json({ error: "Forbidden", message: `${scope} is local-only without ${cfg.token}. Bind the dashboard to loopback or configure ${cfg.token}.` }, { status: 403 })
}

export function authorizeStatusRequest(request: Request): Response | null {
  return authorize(request, "status")
}

export function authorizeInterventionRequest(request: Request): Response | null {
  return authorize(request, "intervention")
}

export function authorizeInterventionMutation(request: Request): Response | null {
  const denied = authorizeInterventionRequest(request)
  if (denied) return denied
  const supplied = bearer(request)
  if (supplied && validToken("intervention", supplied)) return null
  if (sameOrigin(request)) return null
  return Response.json({ error: "Forbidden", message: "The Origin header must match this dashboard for browser mutations." }, { status: 403 })
}
