/**
 * LedgerBridge wiring — pure gating decision + factory extracted from
 * apps/dashboard/src/lib/bootstrap.ts so it is unit-testable without
 * booting the full Next.js app.
 *
 * Team dashboard relay is opt-in: it only activates when
 * `config.isTeamMode()` is true (team.relay_url + team.id) AND a valid
 * endpoint-bound user session exists on disk (`av login`). Any other state — single-node
 * setups, or team config present but not yet logged in — is a clean
 * no-op, never a crash.
 */

import type { Config } from "../config/yaml-loader"
import { isTeamMode } from "../config/yaml-loader"
import { logger } from "../observability/logger"
import type { Orchestrator } from "../orchestrator/orchestrator"
import type { RelayCredentials } from "./credentials"
import { loadRelayCredentials, validateRelayCredentials } from "./credentials"
import { LedgerBridge } from "./ledger-bridge"
import { generateNodeId } from "./node-id"
import { TeamRelayClient } from "./team-relay-client"
import { TeamRelayPublisher } from "./team-relay-publisher"

export type LedgerRelayReason = "single_node" | "missing_session" | "ready"

export interface LedgerRelayDecision {
  enabled: boolean
  reason: LedgerRelayReason
}

/** Pure gating decision — no I/O beyond the caller-supplied credentials value. */
export function decideLedgerRelay(config: Config, credentials: RelayCredentials | null): LedgerRelayDecision {
  if (!isTeamMode(config)) return { enabled: false, reason: "single_node" }
  if (
    !config.teamRelayUrl ||
    !config.teamId ||
    !validateRelayCredentials(credentials, { relayUrl: config.teamRelayUrl, teamId: config.teamId })
  )
    return { enabled: false, reason: "missing_session" }
  return { enabled: true, reason: "ready" }
}

/**
 * Build + attach a LedgerBridge to `orchestrator` when team mode is
 * configured and a valid user session exists; otherwise returns
 * null. Must be called before `orchestrator.start()` so the initial
 * `node.join` event (emitted from OrchestratorCore.start()) is not
 * missed.
 *
 * Never throws: any construction failure is logged as WARN and treated
 * as "relay disabled" so single-node setups — and misconfigured team
 * setups — are never blocked from booting.
 */
export function wireLedgerRelay(
  orchestrator: Orchestrator,
  config: Config,
  credentialsLoader: () => RelayCredentials | null = loadRelayCredentials,
): LedgerBridge | null {
  try {
    if (!isTeamMode(config)) return null
    const credentials = credentialsLoader()
    const decision = decideLedgerRelay(config, credentials)

    if (!decision.enabled) {
      if (decision.reason === "missing_session") {
        logger.warn(
          "ledger-wiring",
          "Team mode configured but no valid session for team.relay_url and team.id — ledger relay disabled",
          { fix: "Run 'av login' from the project root, then restart Symphony." },
        )
      }
      return null
    }

    // decision.enabled implies credentials !== null; the config fields
    // are re-checked here only to satisfy the type checker (isTeamMode
    // narrows at runtime, not at the type level).
    if (!config.teamRelayUrl || !config.teamId || !credentials) return null

    const nodeId = generateNodeId(credentials.userId)
    const publisher = new TeamRelayPublisher(
      new TeamRelayClient({ relayUrl: config.teamRelayUrl, token: credentials.accessToken, teamId: config.teamId }),
    )
    const bridge = new LedgerBridge(orchestrator, publisher, nodeId)
    logger.info("ledger-wiring", "Team ledger relay enabled", { nodeId, teamId: config.teamId })
    return bridge
  } catch {
    logger.warn(
      "ledger-wiring",
      "Failed to initialize team ledger relay — continuing without it. Check team.relay_url and run av login again.",
    )
    return null
  }
}
