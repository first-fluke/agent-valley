import { createHash, randomBytes } from "node:crypto"
import { type Client, createClient, type InValue, type Transaction } from "@libsql/client"
import { and, eq, isNull, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"
import { z } from "zod"
import type { LedgerEvent } from "../domain/ledger"
import {
  eventIdSchema,
  ledgerEventSchema,
  publishableEventSchema,
  type TeamIdentity,
  teamIdentitySchema,
  teamIdSchema,
} from "./team-event-codec"
import { TeamRelayError } from "./team-relay-error"
import { resolveTursoMigrationDirectory } from "./turso-migration-assets"
import * as schema from "./turso-schema"

export type { TeamIdentity } from "./team-event-codec"

const identitySql = `select m.user_id, m.team_id, m.display_name, m.role, t.expires_at
  from team_tokens t join team_members m on m.team_id = t.team_id and m.user_id = t.user_id
  where t.token_hash = ? and t.team_id = ? and t.expires_at > ? and t.revoked_at is null`
const sessionError = () =>
  new TeamRelayError("session_invalid", "Team session is unavailable or expired. Run av login again.", 401)
const invalidRequest = () =>
  new TeamRelayError("invalid_request", "Supply a valid team identity, event ID and bounded cursor.", 400)

function tokenHash(token: string): string {
  if (!/^avt_[A-Za-z0-9_-]{43}$/.test(token)) throw sessionError()
  return createHash("sha256").update(token).digest("hex")
}

export function assertTeamForeignKeys(value: unknown): void {
  if (value !== 1)
    throw new TeamRelayError(
      "team_storage_error",
      "Enable SQLite foreign key enforcement on the server connection before writing team data.",
      503,
    )
}

/** Only the AV server and explicit administration commands receive this database capability. */
export class TursoTeamStore {
  readonly client: Client
  readonly db: ReturnType<typeof drizzle<typeof schema>>

  constructor(options: { url: string; authToken?: string; client?: Client }) {
    this.client = options.client ?? createClient({ url: options.url, authToken: options.authToken, intMode: "number" })
    this.db = drizzle(this.client, { schema })
  }

  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof TeamRelayError) throw error
      throw new TeamRelayError(
        "team_storage_error",
        "Team storage is unavailable. Ask its administrator to check the database configuration and schema.",
        503,
      )
    }
  }

  /** Explicit administrator action; request handlers must never call this method. */
  async initialize(): Promise<void> {
    await this.guard(async () => {
      await migrate(this.db, {
        migrationsFolder: await resolveTursoMigrationDirectory(),
      })
    })
  }

  async ensureTeam(input: { id: string; name: string; slug: string }): Promise<void> {
    const parsed = z
      .strictObject({
        id: teamIdSchema,
        name: z.string().trim().min(1).max(200),
        slug: z.string().trim().min(1).max(200),
      })
      .safeParse(input)
    if (!parsed.success) throw invalidRequest()
    await this.guard(async () => {
      await this.db
        .insert(schema.teams)
        .values(parsed.data)
        .onConflictDoUpdate({ target: schema.teams.id, set: { name: parsed.data.name, slug: parsed.data.slug } })
    })
  }

  async issueToken(input: TeamIdentity): Promise<{ token: string; identity: TeamIdentity }> {
    const parsed = teamIdentitySchema.safeParse(input)
    if (!parsed.success || parsed.data.expiresAt <= Date.now()) throw invalidRequest()
    const identity = parsed.data
    const token = `avt_${randomBytes(32).toString("base64url")}`
    await this.guard(async () => {
      await this.db.transaction(async (tx) => {
        assertTeamForeignKeys((await tx.get<{ foreign_keys: number }>(sql`pragma foreign_keys`))?.foreign_keys)
        await tx
          .insert(schema.teamMembers)
          .values({
            teamId: identity.teamId,
            userId: identity.userId,
            displayName: identity.displayName,
            role: identity.role,
          })
          .onConflictDoUpdate({
            target: [schema.teamMembers.teamId, schema.teamMembers.userId],
            set: { displayName: identity.displayName, role: identity.role },
          })
        await tx.insert(schema.teamTokens).values({
          tokenHash: tokenHash(token),
          teamId: identity.teamId,
          userId: identity.userId,
          expiresAt: identity.expiresAt,
        })
      })
    })
    return { token, identity }
  }

  async revokeTokens(teamId: string, userId: string): Promise<void> {
    if (!teamIdSchema.safeParse(teamId).success || !z.uuid().safeParse(userId).success) throw invalidRequest()
    await this.guard(async () => {
      await this.db
        .update(schema.teamTokens)
        .set({ revokedAt: Date.now() })
        .where(
          and(
            eq(schema.teamTokens.teamId, teamId),
            eq(schema.teamTokens.userId, userId),
            isNull(schema.teamTokens.revokedAt),
          ),
        )
    })
  }

  private async identity(
    token: string,
    teamId: string,
    db: Client | Transaction = this.client,
    now = Date.now(),
  ): Promise<TeamIdentity> {
    if (!teamIdSchema.safeParse(teamId).success) throw sessionError()
    const result = await db.execute({ sql: identitySql, args: [tokenHash(token), teamId, now] })
    const row = result.rows[0]
    if (!row) throw sessionError()
    return teamIdentitySchema.parse({
      userId: row.user_id,
      teamId: row.team_id,
      displayName: row.display_name,
      role: row.role,
      expiresAt: row.expires_at,
    })
  }

  async authenticate(token: string, teamId: string): Promise<TeamIdentity> {
    return this.guard(() => this.identity(token, teamId))
  }

  async publish(token: string, teamId: string, eventId: string, event: unknown): Promise<void> {
    const parsed = publishableEventSchema.safeParse(event)
    if (!parsed.success || !eventIdSchema.safeParse(eventId).success)
      throw new TeamRelayError("invalid_event", "Supply a valid ledger event and stable event ID.", 400)
    const value = parsed.data
    await this.guard(async () => {
      const tx = await this.client.transaction("write")
      try {
        assertTeamForeignKeys((await tx.execute("pragma foreign_keys")).rows[0]?.foreign_keys)
        const now = Date.now()
        const identity = await this.identity(token, teamId, tx, now)
        if (
          !value.nodeId.toLowerCase().startsWith(`${identity.userId.toLowerCase()}:`) ||
          value.nodeId.length <= identity.userId.length + 1
        )
          throw new TeamRelayError(
            "node_access_denied",
            "Use the signed-in user ID and a nonempty machine name for the node ID.",
            403,
          )
        const payload = JSON.stringify(value.payload)
        const args: InValue[] = [
          teamId,
          eventId,
          value.nodeId,
          identity.userId,
          value.type,
          payload,
          value.clientTimestamp,
          tokenHash(token),
          teamId,
          now,
        ]
        const inserted = await tx.execute({
          sql: `insert into ledger_events(team_id,event_id,node_id,user_id,type,payload,client_timestamp,source)
            select ?,?,?,?,?,?,?,'native' where exists (${identitySql})
            on conflict(team_id,event_id) do nothing`,
          args,
        })
        if (!inserted.rowsAffected) {
          const existing = (
            await tx.execute({
              sql: "select node_id,user_id,type,payload,client_timestamp from ledger_events where team_id=? and event_id=?",
              args: [teamId, eventId],
            })
          ).rows[0]
          if (
            !existing ||
            existing.node_id !== value.nodeId ||
            existing.user_id !== identity.userId ||
            existing.type !== value.type ||
            existing.payload !== payload ||
            existing.client_timestamp !== value.clientTimestamp
          )
            throw new TeamRelayError(
              "event_conflict",
              "This event ID already belongs to different event content. Retain the original ID only for exact retries.",
              409,
            )
        }
        await tx.commit()
      } finally {
        tx.close()
      }
    })
  }

  async readEvents(token: string, teamId: string, afterSeq: number, limit: number): Promise<LedgerEvent[]> {
    if (
      !teamIdSchema.safeParse(teamId).success ||
      !Number.isSafeInteger(afterSeq) ||
      afterSeq < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1_000
    )
      throw invalidRequest()
    return this.guard(async () => {
      const result = await this.client.execute({
        sql: `with identity as (${identitySql})
          select i.user_id as authenticated_user_id,e.seq,e.node_id,e.type,e.payload,e.client_timestamp,e.created_at
          from identity i left join (
            select seq,node_id,type,payload,client_timestamp,created_at from ledger_events
            where team_id=? and seq>? order by seq asc limit ?
          ) e on 1=1 order by e.seq asc`,
        args: [tokenHash(token), teamId, Date.now(), teamId, afterSeq, limit],
      })
      if (!result.rows.length) throw sessionError()
      return result.rows
        .filter((row) => row.seq !== null)
        .map((row) =>
          ledgerEventSchema.parse({
            v: 1,
            seq: row.seq,
            nodeId: row.node_id,
            type: row.type,
            payload: JSON.parse(String(row.payload)),
            clientTimestamp: row.client_timestamp,
            relayTimestamp: row.created_at,
          }),
        )
    })
  }

  close(): void {
    this.client.close()
  }
}
