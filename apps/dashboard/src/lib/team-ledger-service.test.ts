import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, test, vi } from "vitest"
import { TeamPanel } from "@/features/team/components/team-panel"
import { readTeamLedger } from "./team-ledger-service"

const folders: string[] = []
const userId = "2179cd67-714f-474b-b018-9411dcc34353"
const config = { teamRelayUrl: "https://team.example.test/gateway", teamId: "c7765322-08c7-4f5d-9e4b-d3ccba94d50b" }
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function credentials(overrides: Record<string, unknown> = {}): string {
  const folder = mkdtempSync(join(tmpdir(), "av-team-ledger-"))
  folders.push(folder)
  const path = join(folder, "credentials.json")
  writeFileSync(
    path,
    JSON.stringify({
      accessToken: "private-user-token",
      expiresAt: Date.now() + 60_000,
      relayUrl: config.teamRelayUrl,
      teamId: config.teamId,
      userId,
      ...overrides,
    }),
  )
  return path
}

function session(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    identity: {
      userId,
      teamId: config.teamId,
      displayName: "Alice",
      role: "member",
      expiresAt: Date.now() + 60_000,
      ...overrides,
    },
  })
}

function event(seq: number, type: string, payload: Record<string, unknown>) {
  return {
    v: 1,
    seq,
    nodeId: `${userId}:desktop`,
    type,
    payload,
    clientTimestamp: "2026-10-21T00:00:00Z",
    relayTimestamp: "2026-10-21T00:00:00Z",
  }
}
const joinPayload = { defaultAgentType: "antigravity", maxParallel: 2, displayName: "Alice" }

describe("team ledger gateway reader", () => {
  test("preserves standalone mode without client team config", async () => {
    expect(await readTeamLedger({})).toEqual({ mode: "standalone" })
  })

  test("rejects partial, insecure and invalid team configuration before any request", async () => {
    const fetcher = vi.fn(async () => session())
    expect(await readTeamLedger({ teamId: config.teamId }, { fetcher })).toMatchObject({
      code: "team_config_incomplete",
    })
    expect(await readTeamLedger({ ...config, teamRelayUrl: "http://remote.example.test" }, { fetcher })).toMatchObject({
      code: "team_config_invalid",
    })
    expect(await readTeamLedger({ ...config, teamId: "invalid-team" }, { fetcher })).toMatchObject({
      code: "team_config_invalid",
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  test("rejects absent, expired, legacy, gateway-path-mismatched and team-mismatched saved credentials", async () => {
    const fetcher = vi.fn(async () => session())
    const paths = [
      "/does-not-exist",
      credentials({ expiresAt: Date.now() - 1 }),
      credentials({ relayUrl: "https://team.example.test/another-gateway" }),
      credentials({ teamId: "9ef049fa-5dac-43fa-9d3a-f834ca32f29d" }),
      credentials({ relayUrl: undefined, supabaseUrl: "https://retired.example.test" }),
    ]
    for (const credentialsPath of paths)
      expect(await readTeamLedger(config, { credentialsPath, fetcher })).toMatchObject({ code: "missing_session" })
    expect(fetcher).not.toHaveBeenCalled()
  })

  test("uses only an opaque team token on its bound gateway and returns replayed state without credentials", async () => {
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      expect(url.origin).toBe("https://team.example.test")
      expect(url.searchParams.get("team_id")).toBe(config.teamId)
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer private-user-token")
      expect(new Headers(init.headers).has("apikey")).toBe(false)
      expect(init.redirect).toBe("error")
      expect(init.cache).toBe("no-store")
      if (url.pathname === "/gateway/api/team/session") return session()
      expect(url.pathname).toBe("/gateway/api/team/relay")
      expect(url.searchParams.get("after")).toBe("0")
      expect(url.searchParams.get("limit")).toBe("1000")
      return Response.json({
        events: [
          event(1, "node.join", joinPayload),
          event(2, "agent.start", { agentType: "antigravity", issueKey: "AV-12", issueId: "issue-12" }),
        ],
      })
    })
    const result = await readTeamLedger(config, { credentialsPath: credentials(), fetcher })
    expect(result).toMatchObject({ mode: "team", status: "connected", state: { lastSeq: 2 } })
    if (result.mode !== "team" || result.status !== "connected") throw new Error("Expected team state")
    const html = renderToStaticMarkup(createElement(TeamPanel, { teamState: result.state }))
    expect(html).toContain("Alice")
    expect(html).toContain("AV-12")
    expect(html).toContain("antigravity")
    expect(JSON.stringify(result)).not.toContain("private-user-token")
    expect(JSON.stringify(result)).not.toContain("accessToken")
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  test("advances a sequence cursor across full pages rather than reloading the first page", async () => {
    const cursors: number[] = []
    const fetcher = vi.fn(async (url: URL) => {
      if (url.pathname.endsWith("/session")) return session()
      const after = Number(url.searchParams.get("after"))
      cursors.push(after)
      return Response.json({
        events:
          after === 0
            ? Array.from({ length: 1000 }, (_, index) =>
                index === 0
                  ? event(1, "node.join", joinPayload)
                  : event(index + 1, "node.reconnect", { lastSeq: index }),
              )
            : [event(1001, "agent.start", { agentType: "codex", issueKey: "AV-20", issueId: "issue-20" })],
      })
    })
    expect(await readTeamLedger(config, { credentialsPath: credentials(), fetcher })).toMatchObject({
      status: "connected",
      state: { lastSeq: 1001 },
    })
    expect(cursors).toEqual([0, 1000])
  })

  test.each([401, 403])(
    "reports gateway auth rejection %s without forwarding server messages or tokens",
    async (status) => {
      const result = await readTeamLedger(config, {
        credentialsPath: credentials(),
        fetcher: async () => Response.json({ message: "private-database-token" }, { status }),
      })
      expect(result).toMatchObject({ code: status === 401 ? "session_invalid" : "team_access_denied" })
      expect(JSON.stringify(result)).not.toContain("private-database-token")
      expect(JSON.stringify(result)).not.toContain("private-user-token")
    },
  )

  test("rejects malformed events, out-of-order pages and a changed authenticated identity", async () => {
    for (const events of [
      [event(1, "node.join", { displayName: "Incomplete" })],
      [event(2, "node.join", joinPayload), event(1, "node.join", joinPayload)],
    ]) {
      const result = await readTeamLedger(config, {
        credentialsPath: credentials(),
        fetcher: async (url) => (url.pathname.endsWith("/session") ? session() : Response.json({ events })),
      })
      expect(result).toMatchObject({ code: "invalid_ledger" })
    }
    const mismatch = await readTeamLedger(config, {
      credentialsPath: credentials(),
      fetcher: async () => session({ userId: "39340e1c-e8cd-4fda-a898-69d2d71a53c5" }),
    })
    expect(mismatch).toMatchObject({ code: "session_mismatch" })
  })

  test("bounds history at 20,000 events and reports network failure safely", async () => {
    const overflow = await readTeamLedger(config, {
      credentialsPath: credentials(),
      fetcher: async (url) => {
        if (url.pathname.endsWith("/session")) return session()
        const after = Number(url.searchParams.get("after"))
        return Response.json({
          events: Array.from({ length: 1000 }, (_, index) =>
            event(after + index + 1, "node.reconnect", { lastSeq: after + index }),
          ),
        })
      },
    })
    expect(overflow).toMatchObject({ code: "ledger_limit" })
    const unavailable = await readTeamLedger(config, {
      credentialsPath: credentials(),
      fetcher: async () => {
        throw new Error("private-user-token database details")
      },
    })
    expect(unavailable).toMatchObject({ code: "team_unavailable" })
    expect(JSON.stringify(unavailable)).not.toContain("private-user-token")
  })
})
