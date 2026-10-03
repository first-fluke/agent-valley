import { readFileSync } from "node:fs"
import { AGENT_TYPES, type LedgerEvent, type NodePresence } from "@agent-valley/core/domain/ledger"
import { defaultCredentialsPath } from "@agent-valley/core/relay/credentials"
import { replayLedger } from "@agent-valley/core/relay/replay"
import { z } from "zod"

const PAGE_SIZE = 1000
const MAX_EVENTS = 20_000
const savedCredentialsSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.number().finite(),
  supabaseUrl: z.url(),
  userId: z.string().min(1),
})
const ledgerRowSchema = z.object({
  seq: z.number().int().positive(),
  node_id: z.string().min(1),
  type: z.enum(["node.join", "node.reconnect", "node.leave", "agent.start", "agent.done", "agent.failed", "agent.cancelled"]),
  payload: z.record(z.string(), z.unknown()),
  client_timestamp: z.string(),
  created_at: z.string(),
})
const agentTypeSchema = z.enum(AGENT_TYPES)
const payloadSchemas = {
  "node.join": z.object({ defaultAgentType: agentTypeSchema, maxParallel: z.number(), displayName: z.string() }),
  "node.reconnect": z.object({ lastSeq: z.number() }),
  "node.leave": z.object({ reason: z.enum(["graceful", "crash", "timeout"]) }),
  "agent.start": z.object({ agentType: agentTypeSchema, issueKey: z.string(), issueId: z.string() }),
  "agent.done": z.object({ issueKey: z.string(), issueId: z.string(), durationMs: z.number() }),
  "agent.failed": z.object({ issueKey: z.string(), issueId: z.string(), error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }) }),
  "agent.cancelled": z.object({ issueKey: z.string(), issueId: z.string(), reason: z.string() }),
} as const

export interface TeamLedgerConfig {
  supabaseUrl?: string
  supabaseAnonKey?: string
  teamId?: string
}

export type TeamLedgerResult =
  | { mode: "standalone" }
  | { mode: "team"; status: "connected"; state: { nodes: NodePresence[]; lastSeq: number } }
  | { mode: "team"; status: "error"; code: string; message: string }

interface TeamLedgerDeps {
  credentialsPath?: string
  fetcher?: (input: URL, init: RequestInit) => Promise<Response>
  now?: number
}

function failure(code: string, message: string): TeamLedgerResult {
  return { mode: "team", status: "error", code, message }
}

function toEvent(value: unknown): LedgerEvent {
  const row = ledgerRowSchema.parse(value)
  // Each payload is validated at the external response boundary before it
  // reaches the trusted replay function.
  const payload = payloadSchemas[row.type].parse(row.payload)
  return {
    v: 1,
    seq: row.seq,
    relayTimestamp: row.created_at,
    clientTimestamp: row.client_timestamp,
    nodeId: row.node_id,
    type: row.type,
    payload,
  } as LedgerEvent
}

export async function readTeamLedger(config: TeamLedgerConfig, deps: TeamLedgerDeps = {}): Promise<TeamLedgerResult> {
  const { supabaseUrl, supabaseAnonKey, teamId } = config
  if (!supabaseUrl && !supabaseAnonKey && !teamId) return { mode: "standalone" }
  if (!supabaseUrl || !supabaseAnonKey || !teamId) {
    return failure("team_config_incomplete", "Set team.supabase_url, team.supabase_anon_key, and team.id in av.yaml or settings.yaml.")
  }
  let endpoint: URL
  try {
    endpoint = new URL("/rest/v1/ledger_events", supabaseUrl)
    if (endpoint.protocol !== "https:") throw new Error("HTTPS required")
  } catch {
    return failure("team_config_invalid", "Set team.supabase_url to a valid HTTPS URL.")
  }

  let saved: unknown
  try {
    saved = JSON.parse(readFileSync(deps.credentialsPath ?? defaultCredentialsPath(), "utf8"))
  } catch {
    return failure("missing_session", "No team login found. Run av login on this machine, then restart the dashboard.")
  }
  const credentials = savedCredentialsSchema.safeParse(saved)
  if (!credentials.success) return failure("missing_session", "Team login is invalid. Run av login again.")
  if (credentials.data.expiresAt <= (deps.now ?? Date.now())) {
    return failure("session_expired", "Team login expired. Run av login again, then restart the dashboard.")
  }
  if (new URL(credentials.data.supabaseUrl).origin !== endpoint.origin) {
    return failure("session_mismatch", "Team login belongs to another Supabase project. Run av login for the configured team.")
  }

  const events: LedgerEvent[] = []
  const fetcher = deps.fetcher ?? fetch
  const headers = {
    apikey: supabaseAnonKey,
    Authorization: `Bearer ${credentials.data.accessToken}`,
  }
  const membershipUrl = new URL("/rest/v1/team_members", supabaseUrl)
  membershipUrl.searchParams.set("team_id", `eq.${teamId}`)
  membershipUrl.searchParams.set("user_id", `eq.${credentials.data.userId}`)
  membershipUrl.searchParams.set("select", "user_id")
  membershipUrl.searchParams.set("limit", "1")
  let membership: Response
  try {
    membership = await fetcher(membershipUrl, { headers, cache: "no-store" })
  } catch {
    return failure("team_unavailable", "Team membership could not be checked. Check the Supabase URL and network connection.")
  }
  if (membership.status === 401) return failure("session_expired", "Team login was rejected. Run av login again.")
  if (membership.status === 403) return failure("team_access_denied", "Team membership was denied. Check your membership and Supabase RLS policies.")
  if (!membership.ok) return failure("team_policy_error", `Team membership check failed (${membership.status}). Check the team_members RLS policy.`)
  try {
    const rows: unknown = await membership.json()
    if (!Array.isArray(rows) || rows.length === 0) {
      return failure("team_access_denied", "Your account is not a member of the configured team.")
    }
  } catch {
    return failure("team_policy_error", "Team membership returned invalid data. Check the Supabase schema.")
  }

  for (let offset = 0; offset <= MAX_EVENTS; offset += PAGE_SIZE) {
    const url = new URL(endpoint)
    url.searchParams.set("team_id", `eq.${teamId}`)
    url.searchParams.set("order", "seq.asc")
    url.searchParams.set("limit", String(PAGE_SIZE))
    url.searchParams.set("offset", String(offset))
    let response: Response
    try {
      response = await fetcher(url, {
        headers,
        cache: "no-store",
      })
    } catch {
      return failure("team_unavailable", "Team ledger is unavailable. Check the Supabase URL and network connection.")
    }
    if (response.status === 401) return failure("session_expired", "Team login was rejected. Run av login again.")
    if (response.status === 403) return failure("team_access_denied", "Team access was denied. Check membership and Supabase RLS policies.")
    if (!response.ok) return failure("team_unavailable", `Team ledger request failed (${response.status}).`)

    let rows: unknown
    try {
      rows = await response.json()
      if (!Array.isArray(rows)) throw new Error("Expected rows")
      for (const row of rows) events.push(toEvent(row))
    } catch {
      return failure("invalid_ledger", "Team ledger returned invalid events. Check the Supabase schema and data.")
    }
    if (events.length > MAX_EVENTS) {
      return failure("ledger_limit", "Team ledger has more than 20,000 events. Archive old events before loading the dashboard.")
    }
    if ((rows as unknown[]).length < PAGE_SIZE) break
  }
  const state = replayLedger(events)
  return { mode: "team", status: "connected", state: { nodes: Array.from(state.nodes.values()), lastSeq: state.lastSeq } }
}
