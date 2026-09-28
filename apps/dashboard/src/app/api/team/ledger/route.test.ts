import { afterEach, describe, expect, test, vi } from "vitest"

const readTeamLedger = vi.fn(async (): Promise<{ mode: string; status?: string; code?: string; message?: string }> => ({ mode: "standalone" }))
vi.mock("@/lib/team-ledger-service", () => ({ readTeamLedger }))
vi.mock("@/lib/project-root", () => ({ resolveProjectRoot: async () => "/project" }))
vi.mock("@/lib/env", () => ({ toOrchestratorConfig: () => ({}) }))

const { GET } = await import("./route")
afterEach(() => {
  delete process.env.SYMPHONY_DASHBOARD_TOKEN
  readTeamLedger.mockClear()
})

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/team/ledger", { headers: { host: "localhost", ...headers } })
}

describe("GET /api/team/ledger", () => {
  test("requires dashboard authentication when configured", async () => {
    process.env.SYMPHONY_DASHBOARD_TOKEN = "status-secret"
    expect((await GET(request())).status).toBe(401)
    expect(readTeamLedger).not.toHaveBeenCalled()
    expect((await GET(request({ authorization: "Bearer status-secret" }))).status).toBe(200)
  })

  test("maps team session expiry to an explicit 401", async () => {
    readTeamLedger.mockResolvedValueOnce({
      mode: "team", status: "error", code: "session_expired", message: "Run av login again.",
    })
    const response = await GET(request())
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: "session_expired" })
    expect(response.headers.get("cache-control")).toBe("no-store")
  })
})
