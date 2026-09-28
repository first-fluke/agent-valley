import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { authorizeInterventionMutation, authorizeStatusRequest } from "@/lib/dashboard-auth"
import { DELETE, GET, POST } from "./route"

const keys = ["SYMPHONY_DASHBOARD_TOKEN", "SYMPHONY_INTERVENTION_TOKEN"]
const credentials = { statusToken: "status-secret", interventionToken: "action-secret" }

function request(method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:9741/api/auth/session", {
    method,
    headers: { host: "localhost:9741", origin: "http://localhost:9741", "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

describe("dashboard browser sessions", () => {
  beforeEach(() => {
    process.env.SYMPHONY_DASHBOARD_TOKEN = credentials.statusToken
    process.env.SYMPHONY_INTERVENTION_TOKEN = credentials.interventionToken
  })
  afterEach(() => { for (const key of keys) delete process.env[key] })

  test("issues scoped HttpOnly cookies accepted by status and intervention APIs", async () => {
    const login = await POST(request("POST", credentials))
    expect(login.status).toBe(200)
    const cookies = login.headers.getSetCookie()
    expect(cookies).toHaveLength(2)
    for (const item of cookies) {
      expect(item).toContain("HttpOnly")
      expect(item).toContain("SameSite=Strict")
    }
    const cookieHeader = cookies.map((item) => item.split(";")[0]).join("; ")
    const status = request("GET", undefined, { cookie: cookieHeader })
    expect(authorizeStatusRequest(status)).toBeNull()
    expect(GET(status).status).toBe(200)
    const mutation = new Request("http://localhost:9741/api/intervention", {
      method: "POST", headers: { host: "localhost:9741", origin: "http://localhost:9741", cookie: cookieHeader },
    })
    expect(authorizeInterventionMutation(mutation)).toBeNull()
  })

  test("wrong token receives no cookie and forged Host does not bypass login", async () => {
    const wrong = await POST(request("POST", { ...credentials, statusToken: "wrong" }))
    expect(wrong.status).toBe(401)
    expect(wrong.headers.getSetCookie()).toHaveLength(0)
    expect(authorizeStatusRequest(request("GET", undefined, { host: "localhost:9741" }))?.status).toBe(401)
  })

  test("cookie mutations reject missing or cross-site Origin", async () => {
    const login = await POST(request("POST", credentials))
    const cookieHeader = login.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ")
    const makeMutation = (origin?: string) => new Request("http://localhost:9741/api/intervention", {
      method: "POST", headers: {
        host: "localhost:9741", cookie: cookieHeader,
        ...(origin ? { origin } : {}),
      },
    })
    expect(authorizeInterventionMutation(makeMutation())?.status).toBe(403)
    expect(authorizeInterventionMutation(makeMutation("https://evil.example"))?.status).toBe(403)
  })

  test("login rejects cross-origin requests even with a valid token", async () => {
    const result = await POST(request("POST", credentials, { origin: "https://evil.example" }))
    expect(result.status).toBe(403)
    expect(result.headers.getSetCookie()).toHaveLength(0)
  })

  test("sign-out clears both scoped cookies and rejects a cross-origin request", () => {
    const result = DELETE(request("DELETE"))
    expect(result.status).toBe(200)
    expect(result.headers.getSetCookie()).toHaveLength(2)
    for (const item of result.headers.getSetCookie()) expect(item).toContain("Max-Age=0")
    expect(DELETE(request("DELETE", undefined, { origin: "https://evil.example" })).status).toBe(403)
  })
})
