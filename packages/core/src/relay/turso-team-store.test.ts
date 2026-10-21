import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { PublishableEvent, TeamIdentity } from "./team-event-codec"
import { TeamRelayError } from "./team-relay-error"
import { TursoTeamStore } from "./turso-team-store"

const teamId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const otherTeam = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const userId = "11111111-1111-4111-8111-111111111111"
const otherUser = "22222222-2222-4222-8222-222222222222"
const identity = (overrides: Partial<TeamIdentity> = {}): TeamIdentity => ({
  userId,
  teamId,
  displayName: "Alice",
  role: "member",
  expiresAt: Date.now() + 60_000,
  ...overrides,
})
const event = (overrides: Partial<PublishableEvent> = {}): PublishableEvent =>
  ({
    type: "node.join",
    nodeId: `${userId}:laptop`,
    clientTimestamp: "2026-10-21T00:00:00.000Z",
    payload: { defaultAgentType: "codex", maxParallel: 2, displayName: "Alice" },
    ...overrides,
  }) as PublishableEvent

describe("TursoTeamStore (real isolated SQLite)", () => {
  let store: TursoTeamStore
  let token: string
  beforeEach(async () => {
    store = new TursoTeamStore({ url: "file::memory:" })
    await store.initialize()
    expect((await store.client.execute("select hash,created_at from __drizzle_migrations")).rows).toHaveLength(1)
    await store.ensureTeam({ id: teamId, name: "Alpha", slug: "alpha" })
    await store.ensureTeam({ id: otherTeam, name: "Beta", slug: "beta" })
    token = (await store.issueToken(identity())).token
  })
  afterEach(() => store.close())

  it("initializes explicitly, keeps initialization repeatable and stores only opaque-token hashes", async () => {
    await store.initialize()
    expect(token).toMatch(/^avt_[A-Za-z0-9_-]{43}$/)
    const rows = (await store.client.execute("select token_hash,expires_at from team_tokens")).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]?.token_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(rows)).not.toContain(token)
    expect(await store.authenticate(token, teamId)).toMatchObject({
      userId,
      teamId,
      role: "member",
      displayName: "Alice",
    })
    expect(await store.readEvents(token, teamId, 0, 10)).toEqual([])
  })

  it("does not create schema while serving authentication requests", async () => {
    const fresh = new TursoTeamStore({ url: "file::memory:" })
    try {
      expect((await fresh.client.execute("pragma foreign_keys")).rows[0]?.foreign_keys).toBe(1)
      await expect(fresh.authenticate(token, teamId)).rejects.toMatchObject({ code: "team_storage_error", status: 503 })
      expect((await fresh.client.execute("select name from sqlite_master where type='table'")).rows).toEqual([])
    } finally {
      fresh.close()
    }
  })

  it("publishes validated events and reads strictly ordered, cursor-based team pages", async () => {
    await store.publish(token, teamId, "join", event())
    await store.publish(
      token,
      teamId,
      "start",
      event({ type: "agent.start", payload: { agentType: "codex", issueKey: "AV-1", issueId: "issue-1" } }),
    )
    const page = await store.readEvents(token, teamId, 0, 1)
    expect(page).toHaveLength(1)
    expect(page[0]).toMatchObject({
      v: 1,
      type: "node.join",
      nodeId: `${userId}:laptop`,
      clientTimestamp: "2026-10-21T00:00:00.000Z",
    })
    expect(page[0]?.relayTimestamp).toMatch(/^\d{4}-.*Z$/)
    const next = await store.readEvents(token, teamId, page[0]?.seq ?? 0, 10)
    expect(next.map((entry) => entry.type)).toEqual(["agent.start"])
    const beta = (await store.issueToken(identity({ teamId: otherTeam }))).token
    expect(await store.readEvents(beta, otherTeam, 0, 10)).toEqual([])
    await expect(store.readEvents(token, otherTeam, 0, 10)).rejects.toMatchObject({
      code: "session_invalid",
      status: 401,
    })
  })

  it("deduplicates exact retries and rejects ID reuse by changed content or another principal", async () => {
    await store.publish(token, teamId, "stable", event())
    await store.publish(token, teamId, "stable", event())
    expect(await store.readEvents(token, teamId, 0, 10)).toHaveLength(1)
    await expect(
      store.publish(token, teamId, "stable", event({ clientTimestamp: "2026-10-21T00:00:01.000Z" })),
    ).rejects.toMatchObject({ code: "event_conflict", status: 409 })
    const bob = (await store.issueToken(identity({ userId: otherUser, displayName: "Bob" }))).token
    await expect(store.publish(bob, teamId, "stable", event({ nodeId: `${otherUser}:laptop` }))).rejects.toMatchObject({
      code: "event_conflict",
    })
    expect(await store.readEvents(token, teamId, 0, 10)).toHaveLength(1)
  })

  it("rejects forged identities, provenance and node ownership", async () => {
    await expect(store.publish(token, teamId, "spoof", { ...event(), userId: otherUser })).rejects.toMatchObject({
      code: "invalid_event",
    })
    await expect(
      store.publish(token, teamId, "source", { ...event(), source: "supabase-import" }),
    ).rejects.toMatchObject({ code: "invalid_event" })
    await expect(store.publish(token, teamId, "node", event({ nodeId: `${otherUser}:laptop` }))).rejects.toMatchObject({
      code: "node_access_denied",
      status: 403,
    })
    await expect(store.publish(token, teamId, "empty", event({ nodeId: `${userId}:` }))).rejects.toMatchObject({
      code: "node_access_denied",
    })
    await expect(store.publish(token, teamId, "legacy", event({ nodeId: "alice:laptop" }))).rejects.toMatchObject({
      code: "node_access_denied",
    })
    expect(await store.readEvents(token, teamId, 0, 10)).toEqual([])
  })

  it("checks token expiry, revocation and live membership on every read and write", async () => {
    await store.client.execute({ sql: "update team_tokens set expires_at=?", args: [Date.now() - 1] })
    await expect(store.authenticate(token, teamId)).rejects.toMatchObject({ code: "session_invalid" })
    await expect(store.readEvents(token, teamId, 0, 10)).rejects.toMatchObject({ code: "session_invalid" })
    await expect(store.publish(token, teamId, "expired", event())).rejects.toMatchObject({ code: "session_invalid" })
    const fresh = (await store.issueToken(identity())).token
    await store.revokeTokens(teamId, userId)
    await expect(store.authenticate(fresh, teamId)).rejects.toMatchObject({ code: "session_invalid" })
    const removed = (await store.issueToken(identity())).token
    await store.client.execute({
      sql: "delete from team_members where team_id=? and user_id=?",
      args: [teamId, userId],
    })
    await expect(store.authenticate(removed, teamId)).rejects.toMatchObject({ code: "session_invalid" })
    await expect(store.publish(removed, teamId, "removed", event())).rejects.toMatchObject({ code: "session_invalid" })
    expect((await store.client.execute("select * from ledger_events")).rows).toEqual([])
  })

  it("retains legacy node IDs only for explicit administrator imports", async () => {
    await store.client.execute({
      sql: "insert into ledger_events(seq,team_id,event_id,node_id,user_id,type,payload,client_timestamp,created_at,source) values (42,?,?,?,?,?,?,?,?, 'supabase-import')",
      args: [
        teamId,
        "legacy-42",
        "alice:old",
        userId,
        "node.join",
        JSON.stringify(event().payload),
        "2026-10-01T00:00:00.000Z",
        "2026-10-01T00:00:01.000Z",
      ],
    })
    const events = await store.readEvents(token, teamId, 0, 10)
    expect(events[0]).toMatchObject({ seq: 42, nodeId: "alice:old", relayTimestamp: "2026-10-01T00:00:01.000Z" })
    await store.publish(token, teamId, "native", event())
    expect((await store.readEvents(token, teamId, 42, 10))[0]?.seq).toBeGreaterThan(42)
  })

  it("retains historical events when membership is removed without granting the former user access", async () => {
    await store.publish(token, teamId, "history", event())
    const bob = (await store.issueToken(identity({ userId: otherUser, displayName: "Bob" }))).token
    await store.client.execute({
      sql: "delete from team_members where team_id=? and user_id=?",
      args: [teamId, userId],
    })
    await expect(store.readEvents(token, teamId, 0, 10)).rejects.toMatchObject({ code: "session_invalid" })
    expect((await store.readEvents(bob, teamId, 0, 10))[0]?.nodeId).toBe(`${userId}:laptop`)
  })

  it("fails closed on the actual write connection when foreign-key enforcement is disabled", async () => {
    await store.client.execute("pragma foreign_keys=off")
    await expect(store.issueToken(identity({ userId: otherUser }))).rejects.toMatchObject({
      code: "team_storage_error",
      status: 503,
    })
    await expect(store.publish(token, teamId, "no-fk", event())).rejects.toMatchObject({
      code: "team_storage_error",
      status: 503,
    })
    await store.client.execute("pragma foreign_keys=on")
    expect(await store.readEvents(token, teamId, 0, 10)).toEqual([])
  })

  it("enforces DB foreign keys, roles, event types, JSON objects and native node ownership", async () => {
    await expect(
      store.client.execute({
        sql: "insert into team_members(team_id,user_id,role,display_name) values (?,?, 'member','Unknown')",
        args: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", otherUser],
      }),
    ).rejects.toThrow()
    await expect(
      store.client.execute({ sql: "update team_members set role='root' where team_id=?", args: [teamId] }),
    ).rejects.toThrow()
    for (const [type, payload, nodeId] of [
      ["fake", "{}", `${userId}:laptop`],
      ["node.join", "not JSON", `${userId}:laptop`],
      ["node.join", "[]", `${userId}:laptop`],
      ["node.join", "{}", "alice:fake"],
    ]) {
      await expect(
        store.client.execute({
          sql: "insert into ledger_events(team_id,event_id,node_id,user_id,type,payload,client_timestamp) values (?,?,?,?,?,?,?)",
          args: [teamId, "invalid", nodeId ?? "", userId, type ?? "", payload ?? "", event().clientTimestamp],
        }),
      ).rejects.toThrow()
    }
  })

  it("fails closed on invalid requests without echoing credentials or SDK errors", async () => {
    await expect(store.authenticate("secret-invalid-token", teamId)).rejects.toMatchObject({ code: "session_invalid" })
    await expect(store.authenticate(token, "bad-team")).rejects.toMatchObject({ code: "session_invalid" })
    await expect(store.readEvents(token, teamId, -1, 1)).rejects.toMatchObject({ code: "invalid_request" })
    await expect(store.readEvents(token, teamId, 0, 1_001)).rejects.toMatchObject({ code: "invalid_request" })
    await expect(store.ensureTeam({ id: "bad", name: "X", slug: "x" })).rejects.toMatchObject({
      code: "invalid_request",
    })
    await expect(store.issueToken(identity({ expiresAt: Date.now() - 1 }))).rejects.toMatchObject({
      code: "invalid_request",
    })
    await expect(store.revokeTokens(teamId, "bad")).rejects.toMatchObject({ code: "invalid_request" })
    await expect(store.publish(token, teamId, "bad/id", event())).rejects.toMatchObject({ code: "invalid_event" })
    const fresh = new TursoTeamStore({ url: "file::memory:" })
    try {
      await fresh.authenticate(token, teamId).catch((error: unknown) => {
        expect(error).toBeInstanceOf(TeamRelayError)
        expect(String(error)).not.toContain(token)
        expect(String(error)).not.toContain("SELECT")
      })
    } finally {
      fresh.close()
    }
  })
})
