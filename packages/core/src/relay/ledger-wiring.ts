/**
 * LedgerBridge wiring — pure gating decision + factory extracted from
 * apps/dashboard/src/lib/bootstrap.ts so it is unit-testable without
 * booting the full Next.js app.
 *
 * Team dashboard relay is opt-in: it only activates when
 * `config.isTeamMode()` is true (supabase_url + supabase_anon_key +
 * team.id are all set in valley.yaml/settings.yaml) AND a valid Supabase
 * session exists on disk (`av login`). Any other state — single-node
 * setups, or team config present but not yet logged in — is a clean
 * no-op, never a crash.
 */

import type { Config } from "../config/yaml-loader"
import { isTeamMode } from "../config/yaml-loader"
import { logger } from "../observability/logger"
import type { Orchestrator } from "../orchestrator/orchestrator"
import type { RelayCredentials } from "./credentials"
import { loadRelayCredentials } from "./credentials"
import { LedgerBridge } from "./ledger-bridge"
import { generateNodeId } from "./node-id"
import { SupabaseLedgerClient } from "./supabase-ledger-client"

export type LedgerRelayReason = "single_node" | "missing_session" | "ready"

export interface LedgerRelayDecision {
  enabled: boolean
  reason: LedgerRelayReason
}

/** Pure gating decision — no I/O beyond the caller-supplied credentials value. */
export function decideLedgerRelay(config: Config, credentials: RelayCredentials | null): LedgerRelayDecision {
  if (!isTeamMode(config)) return { enabled: false, reason: "single_node" }
  if (!credentials) return { enabled: false, reason: "missing_session" }
  return { enabled: true, reason: "ready" }
}

/**
 * Build + attach a LedgerBridge to `orchestrator` when team mode is
 * configured and a valid Supabase session exists; otherwise returns
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
    const credentials = credentialsLoader()
    const decision = decideLedgerRelay(config, credentials)

    if (!decision.enabled) {
      if (decision.reason === "missing_session") {
        logger.warn(
          "ledger-wiring",
          "Team mode configured (team.supabase_url/supabase_anon_key/id set) but no Supabase session found — ledger relay disabled",
          { fix: "Run 'av login' from the project root, then restart Symphony." },
        )
      }
      return null
    }

    // decision.enabled implies credentials !== null; the config fields
    // are re-checked here only to satisfy the type checker (isTeamMode
    // narrows at runtime, not at the type level).
    if (!config.supabaseUrl || !config.supabaseAnonKey || !config.teamId || !credentials) return null

    const nodeId = generateNodeId()
    const publisher = new SupabaseLedgerClient(
      config.supabaseUrl,
      config.supabaseAnonKey,
      credentials.accessToken,
      nodeId,
      config.teamId,
      credentials.userId,
    )
    const bridge = new LedgerBridge(orchestrator, publisher, nodeId)
    logger.info("ledger-wiring", "Team ledger relay enabled", { nodeId, teamId: config.teamId })
    return bridge
  } catch (err) {
    logger.warn("ledger-wiring", "Failed to initialize team ledger relay — continuing without it", {
      error: String(err),
    })
    return null
  }
}
