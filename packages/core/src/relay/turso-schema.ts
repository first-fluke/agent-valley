import { sql } from "drizzle-orm"
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

const createdAt = () => text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)

export const teams = sqliteTable(
  "teams",
  {
    id: text("id").primaryKey().notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("teams_slug_unique").on(table.slug),
    check("teams_name_length", sql`length(trim(${table.name})) between 1 and 200`),
    check("teams_slug_length", sql`length(trim(${table.slug})) between 1 and 200`),
  ],
)

export const teamMembers = sqliteTable(
  "team_members",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ["owner", "admin", "member"] }).notNull(),
    displayName: text("display_name").notNull(),
    joinedAt: text("joined_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.userId] }),
    index("idx_team_members_user").on(table.userId),
    check("team_members_role", sql`${table.role} in ('owner', 'admin', 'member')`),
    check("team_members_display_name_length", sql`length(trim(${table.displayName})) between 1 and 200`),
  ],
)

export const teamTokens = sqliteTable(
  "team_tokens",
  {
    tokenHash: text("token_hash").primaryKey().notNull(),
    teamId: text("team_id").notNull(),
    userId: text("user_id").notNull(),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    foreignKey({
      columns: [table.teamId, table.userId],
      foreignColumns: [teamMembers.teamId, teamMembers.userId],
    }).onDelete("cascade"),
    index("idx_team_tokens_member").on(table.teamId, table.userId),
    check("team_tokens_hash_length", sql`length(${table.tokenHash}) = 64`),
    check("team_tokens_expiry", sql`${table.expiresAt} > 0`),
  ],
)

export const ledgerEvents = sqliteTable(
  "ledger_events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id),
    eventId: text("event_id").notNull(),
    nodeId: text("node_id").notNull(),
    userId: text("user_id").notNull(),
    type: text("type").notNull(),
    payload: text("payload").notNull(),
    clientTimestamp: text("client_timestamp").notNull(),
    createdAt: createdAt(),
    source: text("source", { enum: ["native", "supabase-import"] })
      .notNull()
      .default("native"),
  },
  (table) => [
    uniqueIndex("ledger_events_team_event_unique").on(table.teamId, table.eventId),
    index("idx_ledger_team_seq").on(table.teamId, table.seq),
    check("ledger_event_id_length", sql`length(${table.eventId}) between 1 and 200`),
    check(
      "ledger_event_type",
      sql`${table.type} in ('node.join','node.reconnect','node.leave','agent.start','agent.done','agent.failed','agent.cancelled')`,
    ),
    check("ledger_payload_object", sql`json_valid(${table.payload}) and json_type(${table.payload}) = 'object'`),
    check("ledger_source", sql`${table.source} in ('native','supabase-import')`),
    check(
      "ledger_native_node_owner",
      sql`${table.source} = 'supabase-import' or (lower(substr(${table.nodeId}, 1, length(${table.userId}) + 1)) = lower(${table.userId}) || ':' and length(${table.nodeId}) > length(${table.userId}) + 1)`,
    ),
  ],
)
