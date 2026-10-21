import { describe, expect, it, vi } from "vitest"
import type { TeamIdentity } from "./team-event-codec"
import { TeamRelayClient } from "./team-relay-client"

const teamId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const userId = "11111111-1111-4111-8111-111111111111"
const token = "avt_secret-user-token"
const identity: TeamIdentity = { teamId, userId, displayName: "Alice", role: "member", expiresAt: Date.now() + 60_000 }
const event = {
  type: "node.join" as const,
  nodeId: `${userId}:laptop`,
  clientTimestamp: "2026-10-21T00:00:00.000Z",
  payload: { defaultAgentType: "codex" as const, maxParallel: 2, displayName: "Alice" },
}
const ledger = { ...event, v: 1, seq: 1, relayTimestamp: "2026-10-21T00:00:01.000Z" }

describe("TeamRelayClient", () => {
  it("uses only a bearer user token and validates shared session, event and publish contracts", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = []
    const client = new TeamRelayClient({
      relayUrl: "https://relay.example.test/base/",
      token,
      teamId,
      fetcher: async (url, init) => {
        calls.push({ url, init })
        if (url.pathname.endsWith("session")) return Response.json({ identity })
        return Response.json(init.method === "POST" ? { ok: true } : { events: [ledger] })
      },
    })
    expect(await client.getSession()).toEqual(identity)
    expect(await client.readEvents(0, 10)).toEqual([ledger])
    await client.publish(event, "stable-event")
    expect(calls[0]?.url.href).toBe(`https://relay.example.test/base/api/team/session?team_id=${teamId}`)
    expect(calls[1]?.url.searchParams.get("after")).toBe("0")
    expect(calls[1]?.url.searchParams.get("limit")).toBe("10")
    for (const call of calls) {
      expect(call.init.headers).toMatchObject({ Authorization: `Bearer ${token}` })
      expect(call.init.redirect).toBe("error")
      expect(call.url.href).not.toContain(token)
    }
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ teamId, eventId: "stable-event", event })
    expect(JSON.stringify(client)).not.toContain(token)
  })

  it.each([
    "http://relay.example.test",
    "https://user:secret@relay.example.test",
    "https://relay.example.test?secret",
    "https://relay.example.test#secret",
    "ftp://relay.example.test",
  ])("rejects unsafe endpoints before sending credentials: %s", (relayUrl) => {
    const fetcher = vi.fn()
    expect(() => new TeamRelayClient({ relayUrl, token, teamId, fetcher })).toThrow(/team.relay_url/)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("permits a loopback HTTP gateway and rejects invalid credentials and outgoing payloads before fetch", async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true }))
    const client = new TeamRelayClient({ relayUrl: "http://127.0.0.1:3000", token, teamId, fetcher })
    await client.publish(event, "one")
    expect(fetcher).toHaveBeenCalledOnce()
    expect(() => new TeamRelayClient({ relayUrl: "https://relay.test", token: "bad\nheader", teamId })).toThrow()
    expect(() => new TeamRelayClient({ relayUrl: "https://relay.test", token, teamId: "bad" })).toThrow()
    await expect(client.publish({ ...event, userId }, "two")).rejects.toMatchObject({ code: "invalid_event" })
    await expect(client.readEvents(-1, 10)).rejects.toMatchObject({ code: "invalid_request" })
    await expect(client.readEvents(0, 1001)).rejects.toMatchObject({ code: "invalid_request" })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it.each([401, 403, 409, 429, 500])("redacts upstream error bodies at status %i", async (status) => {
    const client = new TeamRelayClient({
      relayUrl: "https://relay.test",
      token,
      teamId,
      fetcher: async () => new Response(`${token}: database password secret`, { status }),
    })
    const error = await client.getSession().catch((value: unknown) => value)
    expect(String(error)).not.toContain(token)
    expect(String(error)).not.toContain("database password")
    expect(error).toHaveProperty("status", status === 500 ? 503 : status)
  })

  it("redacts transport errors rather than echoing request URLs or tokens", async () => {
    const client = new TeamRelayClient({
      relayUrl: "https://relay.test",
      token,
      teamId,
      fetcher: async () => {
        throw new Error(token)
      },
    })
    await expect(client.getSession()).rejects.toMatchObject({ code: "team_unavailable", status: 503 })
    await client.getSession().catch((error: unknown) => expect(String(error)).not.toContain(token))
  })

  it.each([
    { identity: { ...identity, teamId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } },
    { identity: { ...identity, expiresAt: 1 } },
    { identity: { ...identity, userId: "forged" } },
  ])("rejects mismatched, expired or malformed sessions", async (body) => {
    const client = new TeamRelayClient({
      relayUrl: "https://relay.test",
      token,
      teamId,
      fetcher: async () => Response.json(body),
    })
    await expect(client.getSession()).rejects.toThrow()
  })

  it.each([
    { events: [ledger, ledger] },
    { events: [{ ...ledger, payload: { defaultAgentType: "fake" } }] },
    { events: [{ ...ledger, seq: 0 }] },
  ])("rejects unordered or malformed event pages", async ({ events }) => {
    const client = new TeamRelayClient({
      relayUrl: "https://relay.test",
      token,
      teamId,
      fetcher: async () => Response.json({ events }),
    })
    await expect(client.readEvents(0, 10)).rejects.toMatchObject({ code: "invalid_response" })
  })

  it("rejects malformed, missing and oversized response bodies and invalid publish acknowledgements", async () => {
    for (const response of [new Response("not json"), new Response(null), new Response("x".repeat(4_194_305))]) {
      const client = new TeamRelayClient({
        relayUrl: "https://relay.test",
        token,
        teamId,
        fetcher: async () => response,
      })
      await expect(client.getSession()).rejects.toMatchObject({ code: "invalid_response" })
    }
    const client = new TeamRelayClient({
      relayUrl: "https://relay.test",
      token,
      teamId,
      fetcher: async () => Response.json({ ok: false }),
    })
    await expect(client.publish(event, "one")).rejects.toMatchObject({ code: "invalid_response" })
  })
})
