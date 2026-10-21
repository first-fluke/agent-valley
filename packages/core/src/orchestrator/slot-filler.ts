import type { Issue } from "../domain/models"
import { logger } from "../observability/logger"
import { sortByIssueNumber } from "./helpers"
import { CAPACITY_WAIT_REASON } from "./retry-queue"

/**
 * Minimal view of the orchestrator needed to fill capacity. A structural
 * interface (instead of importing OrchestratorCore) keeps this module out of
 * the orchestrator-core ↔ issue-lifecycle ↔ slot-filler import cycle.
 */
interface SlotFillerCore {
  readonly isStopping: boolean
  readonly config: { maxParallel: number; workflowStates: { todo: string } }
  readonly tracker: { fetchIssuesByState(states: string[]): Promise<Issue[]> }
  readonly retryQueue: { entries: readonly { issueId: string; lastError?: string }[] }
  readonly state: { activeWorkspaces: ReadonlyMap<string, unknown> }
  readonly agentRunner: { activeCount: number }
  canAcceptIssue(issueId: string): { ok: boolean; reason?: string }
  removeRetry(issueId: string): void
}

interface SlotDispatcher {
  handleIssueTodo(issue: Issue): Promise<void>
}

export async function fillVacantSlots(core: SlotFillerCore, dispatcher: SlotDispatcher | null): Promise<void> {
  if (!dispatcher || core.isStopping) return
  try {
    const issues = await core.tracker.fetchIssuesByState([core.config.workflowStates.todo])
    sortByIssueNumber(issues)
    let filled = 0
    for (const issue of issues) {
      const queued = core.retryQueue.entries.find((entry) => entry.issueId === issue.id)
      if (queued && queued.lastError !== CAPACITY_WAIT_REASON) continue
      const guard = core.canAcceptIssue(issue.id)
      if (!guard.ok && (guard.reason === "concurrency" || guard.reason === "stopping")) break
      if (!guard.ok) continue
      if (queued) core.removeRetry(issue.id)
      await dispatcher.handleIssueTodo(issue)
      if (core.state.activeWorkspaces.has(issue.id)) filled++
    }
    if (filled > 0) {
      logger.info("orchestrator", `Filled ${filled} vacant slot(s)`, {
        activeCount: String(core.agentRunner.activeCount),
        maxParallel: String(core.config.maxParallel),
      })
    }
  } catch (err) {
    logger.error("orchestrator", "Failed to fill vacant slots", { error: String(err) })
  }
}
