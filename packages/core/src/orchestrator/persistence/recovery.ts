/**
 * Boot recovery decision engine — pure function that classifies each
 * persisted attempt as "reattach" (still alive, block a duplicate
 * spawn) or "reap" (dead/unknown, clean up so the normal dispatch path
 * can safely restart it exactly once).
 *
 * Kept side-effect free and independent of OrchestratorCore so it can
 * be unit tested without spinning up the full orchestrator. The
 * caller (OrchestratorCore.recoverFromPersistedState) is the only
 * place allowed to apply the decision to live runtime state, per the
 * "Orchestrator is the sole state authority" invariant.
 */

import { isProcessAlive } from "./liveness"
import type { PersistedAttempt, PersistedRetryEntry, RunStateSnapshot } from "./run-state-store"

export interface RecoveryDecision {
  /** Attempts whose process is confirmed alive — rehydrate as active. */
  reattach: PersistedAttempt[]
  /** Attempts that are dead or whose liveness cannot be verified (no pid) — clean up. */
  reap: PersistedAttempt[]
  /** Retry queue entries to restore as-is. */
  restoredRetries: PersistedRetryEntry[]
}

/**
 * @param probe Liveness probe, injectable for tests. Defaults to a
 *   real `process.kill(pid, 0)` check.
 */
export function decideRecovery(
  snapshot: RunStateSnapshot,
  probe: (pid: number) => boolean = isProcessAlive,
): RecoveryDecision {
  const reattach: PersistedAttempt[] = []
  const reap: PersistedAttempt[] = []

  for (const attempt of snapshot.activeAttempts) {
    // No pid on record: liveness cannot be verified (see LIMITATION in
    // run-state-store.ts) — reap conservatively rather than risk a
    // blocked-forever "phantom active" entry that never clears.
    if (attempt.pid != null && probe(attempt.pid)) {
      reattach.push(attempt)
    } else {
      reap.push(attempt)
    }
  }

  return { reattach, reap, restoredRetries: snapshot.retryQueue }
}
