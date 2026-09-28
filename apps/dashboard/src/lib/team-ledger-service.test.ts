import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, test, vi } from "vitest"
import { TeamPanel } from "@/features/team/components/team-panel"
import { readTeamLedger } from "./team-ledger-service"

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function credentials(expiresAt = Date.now() + 60_000, url = "https://team.example.com"): string {
  const folder = mkdtempSync(join(tmpdir(), "av-team-ledger-"))
  folders.push(folder)
  const path = join(folder, "credentials.json")
  writeFileSync(path, JSON.stringify({ accessToken: "private-user-token", expiresAt, supabaseUrl: url, userId: "user-1" }))
  return path
}

const config = {
  supabaseUrl: "https://team.example.com",
  supabaseAnonKey: "public-anon-key",
  teamId: "c7765322-08c7-4f5d-9e4b-d3ccba94d50b",
}

function row(seq: number, type: string, payload: Record<string, unknown>) {
  return {
    seq, team_id: config.teamId, node_id: "alice:desktop", user_id: "user-1",
    type, payload, client_timestamp: "2026-09-28T00:00:00Z",
    created_at: "2026-09-28T00:00:00Z",
  }
}

describe("team ledger server relay", () => {
  test("preserves standalone mode without team config", async () => {
    expect(await readTeamLedger({})).toEqual({ mode: "standalone" })
  })

  test("reports incomplete config, absent login, and expired login distinctly", async () => {
    expect(await readTeamLedger({ teamId: config.teamId })).toMatchObject({ code: "team_config_incomplete" })
    expect(await readTeamLedger(config, { credentialsPath: "/does-not-exist" })).toMatchObject({ code: "missing_session" })
    expect(await readTeamLedger(config, { credentialsPath: credentials(Date.now() - 1000) })).toMatchObject({ code: "session_expired" })
    expect(await readTeamLedger(config, { credentialsPath: credentials(Date.now() + 60_000, "https://other.example.com") })).toMatchObject({ code: "session_mismatch" })
  })

  test("uses the user token for RLS, replays ordered events, and renders team state", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(url.origin).toBe("https://team.example.com")
      expect(url.searchParams.get("team_id")).toBe(`eq.${config.teamId}`)
      expect(init?.headers).toMatchObject({
        apikey: "public-anon-key",
        Authorization: "Bearer private-user-token",
      })
      if (url.pathname.endsWith("/team_members")) {
        expect(url.searchParams.get("user_id")).toBe("eq.user-1")
        return Response.json([{ user_id: "user-1" }])
      }
      expect(url.searchParams.get("order")).toBe("seq.asc")
      return Response.json([
        row(1, "node.join", { defaultAgentType: "antigravity", maxParallel: 2, displayName: "Alice" }),
        row(2, "agent.start", { agentType: "antigravity", issueKey: "AV-12", issueId: "issue-12" }),
      ])
    })
    const result = await readTeamLedger(config, { credentialsPath: credentials(), fetcher })
    expect(result).toMatchObject({ mode: "team", status: "connected", state: { lastSeq: 2 } })
    if (result.mode !== "team" || result.status !== "connected") throw new Error("Expected team state")
    expect(result.state.nodes).toHaveLength(1)
    const html = renderToStaticMarkup(createElement(TeamPanel, { teamState: result.state }))
    expect(html).toContain("Alice")
    expect(html).toContain("AV-12")
    expect(html).toContain("antigravity")
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  test("reports Supabase rejection and malformed events without exposing tokens", async () => {
    const path = credentials()
    const rejected = await readTeamLedger(config, {
      credentialsPath: path,
      fetcher: async () => new Response("", { status: 403 }),
    })
    expect(rejected).toMatchObject({ code: "team_access_denied" })
    expect(JSON.stringify(rejected)).not.toContain("private-user-token")
    const invalid = await readTeamLedger(config, {
      credentialsPath: path,
      fetcher: async (url) => String(url).includes("/team_members")
        ? Response.json([{ user_id: "user-1" }])
        : Response.json([row(1, "node.join", { displayName: "Alice" })]),
    })
    expect(invalid).toMatchObject({ code: "invalid_ledger" })
  })

  test("shows non-membership and RLS errors explicitly", async () => {
    const path = credentials()
    const nonMember = await readTeamLedger(config, {
      credentialsPath: path,
      fetcher: async () => Response.json([]),
    })
    expect(nonMember).toMatchObject({ code: "team_access_denied" })
    const policyError = await readTeamLedger(config, {
      credentialsPath: path,
      fetcher: async () => new Response("", { status: 500 }),
    })
    expect(policyError).toMatchObject({ code: "team_policy_error" })
  })
})
