import { normalizeTeamRelayUrl } from "@agent-valley/core/config/team-schema"
import type { LedgerEvent, NodePresence } from "@agent-valley/core/domain/ledger"
import { loadRelayCredentials } from "@agent-valley/core/relay/credentials"
import { replayLedger } from "@agent-valley/core/relay/replay"
import { teamIdSchema } from "@agent-valley/core/relay/team-event-codec"
import { TeamRelayClient, TeamRelayError, type TeamRelayFetch } from "@agent-valley/core/relay/team-relay-client"

const PAGE_SIZE = 1000
const MAX_EVENTS = 20_000

export interface TeamLedgerConfig {
  teamRelayUrl?: string
  teamId?: string
}

export type TeamLedgerResult =
  | { mode: "standalone" }
  | { mode: "team"; status: "connected"; state: { nodes: NodePresence[]; lastSeq: number } }
  | { mode: "team"; status: "error"; code: string; message: string }

interface TeamLedgerDeps {
  credentialsPath?: string
  fetcher?: TeamRelayFetch
  now?: number
}

function failure(code: string, message: string): TeamLedgerResult {
  return { mode: "team", status: "error", code, message }
}

/** The browser receives replayed state; its user token stays on this server and the DB token stays on the gateway. */
export async function readTeamLedger(config: TeamLedgerConfig, deps: TeamLedgerDeps = {}): Promise<TeamLedgerResult> {
  const { teamRelayUrl, teamId } = config
  if (!teamRelayUrl && !teamId) return { mode: "standalone" }
  if (!teamRelayUrl || !teamId)
    return failure("team_config_incomplete", "Set team.relay_url and team.id in av.yaml or settings.yaml.")
  let relayUrl: string
  try {
    relayUrl = normalizeTeamRelayUrl(teamRelayUrl)
    if (!teamIdSchema.safeParse(teamId).success) throw new Error("Invalid team ID")
  } catch {
    return failure(
      "team_config_invalid",
      "Set team.relay_url to HTTPS or loopback HTTP and team.id to its team UUID in av.yaml or settings.yaml.",
    )
  }
  const credentials = loadRelayCredentials(deps.credentialsPath, { relayUrl, teamId }, deps.now)
  if (!credentials)
    return failure(
      "missing_session",
      "No valid login for this gateway and team. Run av login with an AV team token; legacy Supabase sessions cannot be reused.",
    )
  const client = new TeamRelayClient({ relayUrl, token: credentials.accessToken, teamId, fetcher: deps.fetcher })
  try {
    const identity = await client.getSession()
    if (identity.userId !== credentials.userId)
      return failure(
        "session_mismatch",
        "The saved user identity no longer matches its team token. Run av login again.",
      )
    const events: LedgerEvent[] = []
    let cursor = 0
    while (events.length <= MAX_EVENTS) {
      const page = await client.readEvents(cursor, PAGE_SIZE)
      events.push(...page)
      if (events.length > MAX_EVENTS)
        return failure(
          "ledger_limit",
          "Team ledger has more than 20,000 events. Archive old events before loading the dashboard.",
        )
      if (page.length < PAGE_SIZE) break
      cursor = page.at(-1)?.seq ?? cursor
    }
    const state = replayLedger(events)
    return {
      mode: "team",
      status: "connected",
      state: { nodes: Array.from(state.nodes.values()), lastSeq: state.lastSeq },
    }
  } catch (error) {
    if (error instanceof TeamRelayError) {
      if (error.code === "session_invalid")
        return failure("session_invalid", "Team login is invalid, expired or revoked. Run av login again.")
      if (error.code === "team_access_denied")
        return failure("team_access_denied", "Team access was denied. Ask its administrator to check your membership.")
      if (error.code === "invalid_response")
        return failure(
          "invalid_ledger",
          "The team gateway returned invalid data. Ask its administrator to check the relay version and stored events.",
        )
    }
    return failure("team_unavailable", "Team relay is unavailable. Check team.relay_url and the gateway connection.")
  }
}
