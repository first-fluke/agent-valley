import type { RunAttempt } from "../domain/models"
import { logger } from "../observability/logger"
import type { BudgetService } from "./budget-service"

/**
 * Forward session-reported token usage into the BudgetService. Skips
 * silently when the attempt carries no usage block (session could not
 * report) or when no budget is wired on the deps. Any error thrown by
 * recordUsage is downgraded to a WARN log so a flaky observability
 * exporter can never break the completion pipeline.
 *
 * Exported for direct unit testing.
 */
export async function recordBudgetUsage(
  budget: BudgetService | undefined,
  completed: RunAttempt,
  issueId: string,
): Promise<void> {
  if (!budget) return
  const usage = completed.tokenUsage
  if (!usage) {
    logger.debug("completion", "Session reported no tokenUsage — skipping BudgetService.recordUsage", {
      attemptId: completed.id,
      issueId,
    })
    return
  }
  try {
    await budget.recordUsage(completed.id, issueId, usage)
  } catch (err) {
    logger.warn("completion", "BudgetService.recordUsage failed — usage not accumulated", {
      attemptId: completed.id,
      issueId,
      error: String(err),
    })
  }
}
