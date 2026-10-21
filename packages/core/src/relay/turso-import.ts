import { isDeepStrictEqual } from "node:util"
import type { InStatement, Transaction } from "@libsql/client"
import { z } from "zod"
import { publishableEventSchema } from "./team-event-codec"
import { assertTeamForeignKeys, type TursoTeamStore } from "./turso-team-store"

const id = z.uuid()
const timestamp = z.iso.datetime({ offset: true })
const text = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim().length > 0)
const teamSchema = z.strictObject({ id, name: text, slug: text, created_at: timestamp })
const memberSchema = z.strictObject({
  team_id: id,
  user_id: id,
  role: z.enum(["owner", "admin", "member"]),
  display_name: text,
  joined_at: timestamp,
})
const eventSchema = z.strictObject({
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  team_id: id,
  node_id: z.string().min(1).max(1_000),
  user_id: id,
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  client_timestamp: timestamp,
  created_at: timestamp,
})
const snapshotSchema = z.strictObject({
  version: z.literal(1),
  teams: z.array(teamSchema).min(1).max(100),
  team_members: z.array(memberSchema).max(5_000),
  ledger_events: z.array(eventSchema).max(20_000),
})

interface ImportRow {
  table: "teams" | "team_members" | "ledger_events"
  columns: string[]
  values: (string | number)[]
  key: string[]
}
export interface TeamImportResult {
  teams: { inserted: number; unchanged: number }
  members: { inserted: number; unchanged: number }
  events: { inserted: number; unchanged: number }
}

/** Explicit administrator import: preserve identities, sequence numbers and legacy node IDs, never auth secrets. */
export async function importSupabaseTeamSnapshot(store: TursoTeamStore, input: unknown): Promise<TeamImportResult> {
  const snapshot = snapshotSchema.safeParse(input)
  if (!snapshot.success)
    throw new Error(
      "Invalid team export. Export only version, teams, team_members and ledger_events using turso/import/export-supabase.sql; include valid UUIDs, ISO timestamps and at most 20,000 events.",
    )
  const { teams, team_members: members, ledger_events: events } = snapshot.data
  const teamIds = new Set<string>()
  const memberships = new Set<string>()
  const sequences = new Set<number>()
  for (const team of teams) {
    if (teamIds.has(team.id)) throw new Error("Duplicate team in export. Export each team once before retrying.")
    teamIds.add(team.id)
  }
  for (const member of members) {
    const key = `${member.team_id}:${member.user_id}`
    if (!teamIds.has(member.team_id) || memberships.has(key))
      throw new Error("Invalid exported membership. Include its team and list each member once per team.")
    memberships.add(key)
  }
  for (const event of events) {
    if (!teamIds.has(event.team_id) || sequences.has(event.seq))
      throw new Error(
        "Invalid exported event team or sequence. Include its team and retain unique original sequence numbers.",
      )
    const parsed = publishableEventSchema.safeParse({
      nodeId: event.node_id,
      type: event.type,
      payload: event.payload,
      clientTimestamp: event.client_timestamp,
    })
    if (!parsed.success)
      throw new Error("Invalid exported event payload. Restore the original typed ledger event before retrying.")
    sequences.add(event.seq)
  }
  const rows: ImportRow[] = [
    ...teams.map(
      (team): ImportRow => ({
        table: "teams",
        columns: ["id", "name", "slug", "created_at"],
        values: [team.id, team.name, team.slug, team.created_at],
        key: ["id"],
      }),
    ),
    ...members.map(
      (member): ImportRow => ({
        table: "team_members",
        columns: ["team_id", "user_id", "role", "display_name", "joined_at"],
        values: [member.team_id, member.user_id, member.role, member.display_name, member.joined_at],
        key: ["team_id", "user_id"],
      }),
    ),
    ...events.map(
      (event): ImportRow => ({
        table: "ledger_events",
        columns: [
          "seq",
          "team_id",
          "event_id",
          "node_id",
          "user_id",
          "type",
          "payload",
          "client_timestamp",
          "created_at",
          "source",
        ],
        values: [
          event.seq,
          event.team_id,
          `supabase:${event.seq}`,
          event.node_id,
          event.user_id,
          event.type,
          JSON.stringify(event.payload),
          event.client_timestamp,
          event.created_at,
          "supabase-import",
        ],
        key: ["seq"],
      }),
    ),
  ]
  const result: TeamImportResult = {
    teams: { inserted: 0, unchanged: 0 },
    members: { inserted: 0, unchanged: 0 },
    events: { inserted: 0, unchanged: 0 },
  }
  const tx = await store.client.transaction("write")
  try {
    assertTeamForeignKeys((await tx.execute("pragma foreign_keys")).rows[0]?.foreign_keys)
    // Bound each transport batch; the transaction rolls back all batches on conflict or failure.
    for (let offset = 0; offset < rows.length; offset += 100) {
      await importBatch(tx, rows.slice(offset, offset + 100), result)
    }
    await tx.commit()
    return result
  } catch (error) {
    try {
      await tx.rollback()
    } catch {
      /* Preserve the actual import failure. */
    }
    throw error
  } finally {
    tx.close()
  }
}

async function importBatch(tx: Transaction, rows: ImportRow[], result: TeamImportResult): Promise<void> {
  const statements: InStatement[] = rows.flatMap((row) => [
    {
      sql: `insert into ${row.table}(${row.columns.join(",")}) values (${row.columns.map(() => "?").join(",")}) on conflict do nothing`,
      args: row.values,
    },
    {
      sql: `select ${row.columns.join(",")} from ${row.table} where ${row.key.map((column) => `${column}=?`).join(" and ")}`,
      args: row.key.map((column) => row.values[row.columns.indexOf(column)] as string | number),
    },
  ])
  const responses = await tx.batch(statements)
  for (const [index, row] of rows.entries()) {
    const actual = responses[index * 2 + 1]?.rows[0]
    if (
      !actual ||
      row.columns.some((column, i) =>
        column === "payload"
          ? !isDeepStrictEqual(JSON.parse(String(actual[column])), JSON.parse(String(row.values[i])))
          : actual[column] !== row.values[i],
      )
    )
      throw new Error(
        `Existing Turso ${row.table} data conflicts with this export. Use an empty migration target or reconcile the conflicting records; existing data was not overwritten.`,
      )
    const count = result[row.table === "team_members" ? "members" : row.table === "ledger_events" ? "events" : "teams"]
    if (responses[index * 2]?.rowsAffected) count.inserted++
    else count.unchanged++
  }
}
