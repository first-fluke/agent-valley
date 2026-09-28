import type { ResolvedRoute } from "../config/routing"
import type { Issue, RunAttempt } from "../domain/models"
import type { ObservabilityHooks } from "../observability/hooks"
import { logger } from "../observability/logger"
import type { RunCallbacks } from "./agent-runner"
import type { CompletionDeps } from "./completion-handler"

export async function handleAgentFailure(
  deps: CompletionDeps,
  issue: Issue,
  attempt: RunAttempt,
  route: ResolvedRoute,
  err: Parameters<RunCallbacks["onError"]>[0],
  observability: ObservabilityHooks,
): Promise<void> {
  const { config, tracker } = deps
  deps.cleanupState(issue.id, "failed")
  const durationMs = Date.now() - new Date(attempt.startedAt).getTime()
  deps.emitEvent("agent.failed", {
    issueKey: issue.identifier,
    issueId: issue.id,
    error: { code: err.code, message: err.message, retryable: err.recoverable },
  })
  observability.onAgentFailed({
    agentType: route.agentType,
    issueKey: issue.identifier,
    issueId: issue.id,
    attemptId: attempt.id,
    durationMs,
    retryable: err.recoverable,
  })
  logger.warn("completion", `Agent failed for ${issue.identifier}`, { issueId: issue.id, error: err.message })

  const added = err.recoverable ? deps.addRetry(issue.id, (attempt.retryCount ?? 0) + 1, err.message, "infra") : false
  if (!added) {
    if (err.recoverable) {
      try {
        await tracker.addIssueComment(
          issue.id,
          `Symphony: Agent failed (${config.agentMaxRetries} retries exceeded)\n\nError: ${err.message}`,
        )
      } catch (commentErr) {
        logger.debug("completion", "Failed to post max-retries comment", {
          issueId: issue.id,
          error: String(commentErr),
        })
      }
    }
    try {
      await tracker.updateIssueState(issue.id, config.workflowStates.cancelled)
      deps.dagScheduler.updateNodeStatus(issue.id, "cancelled")
    } catch (stateErr) {
      logger.error("completion", "Failed to transition failed issue to Cancelled", {
        issueId: issue.id,
        error: String(stateErr),
      })
    }
  }
  await deps.fillVacantSlots()
}
