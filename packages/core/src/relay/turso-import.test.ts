import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { importSupabaseTeamSnapshot } from "./turso-import"
import { TursoTeamStore } from "./turso-team-store"

const teamId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const userId = "11111111-1111-4111-8111-111111111111"
const formerUser = "22222222-2222-4222-8222-222222222222"
const created = "2026-01-01T00:00:00+00:00"
const snapshot = () => ({
  version: 1,
  teams: [{ id: teamId, name: " Alpha ", slug: "alpha", created_at: created }],
  team_members: [{ team_id: teamId, user_id: userId, role: "owner", display_name: " Alice ", joined_at: created }],
  ledger_events: [
    {
      seq: 42,
      team_id: teamId,
      node_id: "alice:old-laptop",
      user_id: userId,
      type: "node.join",
      payload: { defaultAgentType: "codex", maxParallel: 2, displayName: "Alice" },
      client_timestamp: "2026-01-01T00:00:01+00:00",
      created_at: "2026-01-01T00:00:02+00:00",
    },
  ],
})

describe("Supabase snapshot import into Turso (real SQLite)", () => {
  let store: TursoTeamStore
  beforeEach(async () => {
    store = new TursoTeamStore({ url: "file::memory:" })
    await store.initialize()
  })
  afterEach(() => store.close())

  it("preserves IDs, whitespace, legacy nodes, sequence gaps and timestamps without creating credentials", async () => {
    expect(await importSupabaseTeamSnapshot(store, snapshot())).toEqual({
      teams: { inserted: 1, unchanged: 0 },
      members: { inserted: 1, unchanged: 0 },
      events: { inserted: 1, unchanged: 0 },
    })
    expect((await store.client.execute("select * from teams")).rows[0]).toMatchObject(snapshot().teams[0] ?? {})
    expect((await store.client.execute("select * from team_members")).rows[0]).toMatchObject(
      snapshot().team_members[0] ?? {},
    )
    expect((await store.client.execute("select * from ledger_events")).rows[0]).toMatchObject({
      seq: 42,
      user_id: userId,
      node_id: "alice:old-laptop",
      event_id: "supabase:42",
      source: "supabase-import",
      client_timestamp: "2026-01-01T00:00:01+00:00",
      created_at: "2026-01-01T00:00:02+00:00",
    })
    expect((await store.client.execute("select * from team_tokens")).rows).toEqual([])
    const { token } = await store.issueToken({
      userId,
      teamId,
      role: "owner",
      displayName: "Alice",
      expiresAt: Date.now() + 60_000,
    })
    await store.publish(token, teamId, "new", {
      type: "node.join",
      nodeId: `${userId}:new`,
      clientTimestamp: "2026-10-21T00:00:00.000Z",
      payload: snapshot().ledger_events[0]?.payload,
    })
    expect((await store.readEvents(token, teamId, 42, 10))[0]?.seq).toBeGreaterThan(42)
  })

  it("is repeatable and compares JSON payloads regardless of object key order", async () => {
    await importSupabaseTeamSnapshot(store, snapshot())
    const again = snapshot()
    if (again.ledger_events[0])
      again.ledger_events[0].payload = { displayName: "Alice", maxParallel: 2, defaultAgentType: "codex" }
    expect(await importSupabaseTeamSnapshot(store, again)).toEqual({
      teams: { inserted: 0, unchanged: 1 },
      members: { inserted: 0, unchanged: 1 },
      events: { inserted: 0, unchanged: 1 },
    })
  })

  it("retains former members' historical events without restoring their membership or token", async () => {
    const input = snapshot()
    if (input.ledger_events[0]) input.ledger_events[0].user_id = formerUser
    await importSupabaseTeamSnapshot(store, input)
    expect((await store.client.execute("select user_id from ledger_events")).rows[0]?.user_id).toBe(formerUser)
    expect((await store.client.execute("select user_id from team_members")).rows.map((row) => row.user_id)).toEqual([
      userId,
    ])
    expect((await store.client.execute("select * from team_tokens")).rows).toEqual([])
  })

  it("rolls back every batch on a later conflict and retains pre-existing data", async () => {
    await importSupabaseTeamSnapshot(store, snapshot())
    const input = snapshot()
    const original = input.ledger_events[0]
    if (!original) throw new Error("Missing test fixture")
    input.ledger_events = [
      ...Array.from({ length: 125 }, (_, i) => ({ ...original, seq: i + 100 })),
      { ...original, client_timestamp: "2026-01-02T00:00:00+00:00" },
    ]
    await expect(importSupabaseTeamSnapshot(store, input)).rejects.toThrow("conflicts with this export")
    const rows = (await store.client.execute("select seq,client_timestamp from ledger_events")).rows
    expect(rows).toEqual([{ seq: 42, client_timestamp: original.client_timestamp }])
  })

  it("rejects invalid references, duplicate sequences and typed payloads before writing", async () => {
    const missingTeam = snapshot()
    if (missingTeam.ledger_events[0]) missingTeam.ledger_events[0].team_id = formerUser
    await expect(importSupabaseTeamSnapshot(store, missingTeam)).rejects.toThrow("event team or sequence")
    const duplicate = snapshot()
    if (duplicate.ledger_events[0]) duplicate.ledger_events.push(duplicate.ledger_events[0])
    await expect(importSupabaseTeamSnapshot(store, duplicate)).rejects.toThrow("event team or sequence")
    const invalidPayload = snapshot()
    if (invalidPayload.ledger_events[0]) invalidPayload.ledger_events[0].payload.maxParallel = -1
    await expect(importSupabaseTeamSnapshot(store, invalidPayload)).rejects.toThrow("event payload")
    expect((await store.client.execute("select * from teams")).rows).toEqual([])
  })

  it("rejects authentication data, null timestamps and exports over the bounded limit", async () => {
    await expect(
      importSupabaseTeamSnapshot(store, { ...snapshot(), auth_users: [{ password: "secret" }] }),
    ).rejects.toThrow("Invalid team export")
    const input = snapshot()
    await expect(
      importSupabaseTeamSnapshot(store, { ...input, teams: [{ ...input.teams[0], created_at: null }] }),
    ).rejects.toThrow("Invalid team export")
    await expect(
      importSupabaseTeamSnapshot(store, {
        ...input,
        ledger_events: Array.from({ length: 20_001 }, (_, i) => ({ ...input.ledger_events[0], seq: i + 1 })),
      }),
    ).rejects.toThrow("at most 20,000")
    expect((await store.client.execute("select * from teams")).rows).toEqual([])
  })

  it("refuses an import if foreign key enforcement was disabled on the actual write connection", async () => {
    await store.client.execute("pragma foreign_keys=off")
    await expect(importSupabaseTeamSnapshot(store, snapshot())).rejects.toMatchObject({ code: "team_storage_error" })
    expect((await store.client.execute("select * from teams")).rows).toEqual([])
  })
})
