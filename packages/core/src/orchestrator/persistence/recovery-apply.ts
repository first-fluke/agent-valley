/**
 * Applies a RecoveryDecision (see ./recovery.ts) to live OrchestratorCore
 * state. Extracted out of orchestrator-core.ts to keep that file under
 * the 500-line cap (docs/architecture/CONSTRAINTS.md #5) — this module
 * still only mutates the Maps handed to it by OrchestratorCore, which
 * remains the sole owner/caller. No other component calls this.
 */

import type { OrchestratorRuntimeState, Workspace } from "../../domain/models"
import type { ObservabilityHooks } from "../../observability/hooks"
import { logger } from "../../observability/logger"
import type { RetryQueue } from "../retry-queue"
import type { RecoveryDecision } from "./recovery"
import type { PersistedAttempt, RunStatePort } from "./run-state-store"

export interface RecoveryApplyDeps {
  state: OrchestratorRuntimeState
  activeAttempts: Map<string, string>
  attemptStartedAt: Map<string, string>
  /** issueId -> real OS pid of the spawned agent, when known. See PersistedAttempt.pid. */
  attemptPid: Map<string, number>
  retryQueue: RetryQueue
  observability: ObservabilityHooks
}

export interface RecoverySummary {
  reattached: number
  reaped: number
  restoredRetries: number
}

/**
 * Mutates `deps` in place per the recovery decision:
 *   - `reattach`: rehydrate activeAttempts/activeWorkspaces so
 *     `canAcceptIssue` blocks a duplicate spawn when startup sync
 *     re-dispatches the same InProgress issue.
 *   - `reap`: clear stale bookkeeping so startup sync is free to
 *     legitimately restart the issue exactly once.
 *   - `restoredRetries`: re-added to the retry queue as-is.
 */
export function applyRecoveryDecision(decision: RecoveryDecision, deps: RecoveryApplyDeps): RecoverySummary {
  for (const attempt of decision.reattach) {
    if (!deps.state.activeWorkspaces.has(attempt.issueId)) {
      deps.state.activeWorkspaces.set(attempt.issueId, buildPlaceholderWorkspace(attempt))
    }
    deps.activeAttempts.set(attempt.issueId, attempt.attemptId)
    deps.attemptStartedAt.set(attempt.issueId, attempt.startedAt)
    if (attempt.pid != null) deps.attemptPid.set(attempt.issueId, attempt.pid)
    logger.warn("orchestrator", "Recovered attempt still alive after restart — reattached as active", {
      issueId: attempt.issueId,
      attemptId: attempt.attemptId,
      pid: String(attempt.pid),
    })
  }

  for (const attempt of decision.reap) {
    logger.warn(
      "orchestrator",
      "Recovered attempt is orphaned or its liveness could not be verified — reaping so it can be safely restarted",
      { issueId: attempt.issueId, attemptId: attempt.attemptId, workspacePath: attempt.workspacePath },
    )
    deps.activeAttempts.delete(attempt.issueId)
    deps.attemptStartedAt.delete(attempt.issueId)
    deps.attemptPid.delete(attempt.issueId)
    deps.state.activeWorkspaces.delete(attempt.issueId)
  }

  for (const entry of decision.restoredRetries) {
    deps.retryQueue.add(entry.issueId, entry.attemptCount, entry.lastError, entry.category)
  }
  if (decision.restoredRetries.length > 0) {
    deps.observability.onRetryQueueChanged(deps.retryQueue.size)
  }

  return {
    reattached: decision.reattach.length,
    reaped: decision.reap.length,
    restoredRetries: decision.restoredRetries.length,
  }
}

/** Narrow view of InterventionBus.unregisterAttempt — avoids importing the concrete class here. */
export interface AttemptUnregisterPort {
  unregisterAttempt(attemptId: string): void
}

/**
 * Clears all bookkeeping OrchestratorCore holds for a finished/failed
 * attempt (activeWorkspaces status, activeAttempts, attemptStartedAt,
 * attemptPid, interventionBus). Extracted alongside the other
 * activeAttempts mutators in this module to keep orchestrator-core.ts
 * under the 500-line cap. Caller (`OrchestratorCore.buildCompletionDeps`)
 * still owns persisting the result via `persistActiveAttempts()`.
 */
export function cleanupAttemptState(
  deps: RecoveryApplyDeps & { interventionBus: AttemptUnregisterPort | null },
  issueId: string,
  status: string,
): void {
  const ws = deps.state.activeWorkspaces.get(issueId)
  if (ws) ws.status = status as Workspace["status"]
  const attemptId = deps.activeAttempts.get(issueId)
  deps.state.activeWorkspaces.delete(issueId)
  deps.activeAttempts.delete(issueId)
  deps.attemptStartedAt.delete(issueId)
  deps.attemptPid.delete(issueId)
  if (attemptId && deps.interventionBus) deps.interventionBus.unregisterAttempt(attemptId)
}

/** Synthetic Workspace entry for a reattached attempt — only issueId/path/status are known. */
function buildPlaceholderWorkspace(attempt: PersistedAttempt): Workspace {
  return {
    issueId: attempt.issueId,
    path: attempt.workspacePath,
    key: attempt.issueId,
    branch: "",
    status: "running",
    createdAt: attempt.startedAt,
  }
}

/** Builds the PersistedAttempt[] snapshot mirrored to disk after every activeAttempts mutation. */
export function buildPersistedAttempts(
  activeAttempts: Map<string, string>,
  activeWorkspaces: Map<string, Workspace>,
  attemptStartedAt: Map<string, string>,
  attemptPid: Map<string, number>,
): PersistedAttempt[] {
  const attempts: PersistedAttempt[] = []
  for (const [issueId, attemptId] of activeAttempts) {
    const ws = activeWorkspaces.get(issueId)
    attempts.push({
      issueId,
      attemptId,
      workspacePath: ws?.path ?? "",
      pid: attemptPid.get(issueId) ?? null,
      startedAt: attemptStartedAt.get(issueId) ?? new Date().toISOString(),
    })
  }
  return attempts
}

/** Persist both active attempts and the retry queue snapshot in one call. Test-only convenience export. */
export function persistAll(port: RunStatePort, deps: RecoveryApplyDeps): void {
  port.replaceActiveAttempts(
    buildPersistedAttempts(deps.activeAttempts, deps.state.activeWorkspaces, deps.attemptStartedAt, deps.attemptPid),
  )
  port.replaceRetryQueue(deps.retryQueue.entries)
}
