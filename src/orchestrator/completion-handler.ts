/**
 * Completion Handler — Post-agent-completion logic extracted from Orchestrator.
 * Safety-net (auto-commit), delivery (merge/pr), and exit assessment.
 */

import type { Config } from "../config/env"
import type { ResolvedRoute } from "../config/routing"
import type { Issue, RunAttempt, Workspace } from "../domain/models"
import { logger } from "../observability/logger"
import { addIssueComment, updateIssueState } from "../tracker/linear-client"
import type { WorkspaceManager } from "../workspace/workspace-manager"
import type { RunCallbacks } from "./agent-runner"
import { buildWorkSummary } from "./helpers"

export interface CompletionDeps {
  config: Config
  workspaceManager: WorkspaceManager
  /** Update orchestrator state on completion/failure. Orchestrator remains sole state authority. */
  cleanupState: (issueId: string, status: "done" | "failed") => void
  saveAttempt: (workspace: Workspace, attempt: RunAttempt) => void
  addRetry: (issueId: string, attemptCount: number, error: string) => boolean
  emitEvent: (event: string, payload: Record<string, unknown>) => void
  fillVacantSlots: () => Promise<void>
}

export function createCompletionCallbacks(
  deps: CompletionDeps,
  issue: Issue,
  workspace: Workspace,
  attempt: RunAttempt,
  route: ResolvedRoute,
): RunCallbacks {
  const { config, workspaceManager } = deps

  return {
    onComplete: async (completedAttempt) => {
      deps.cleanupState(issue.id, "done")
      deps.saveAttempt(workspace, completedAttempt)

      // ── Safety net: detect and rescue uncommitted agent work ──
      let autoCommitted = false
      let hasCodeChanges = false

      try {
        const unfinished = await workspaceManager.detectUnfinishedWork(workspace)
        hasCodeChanges = unfinished.hasCodeChanges

        if (unfinished.hasUncommittedChanges) {
          const commitResult = await workspaceManager.autoCommit(workspace)
          autoCommitted = commitResult.ok
          if (autoCommitted) hasCodeChanges = true
          logger.info("completion", `Auto-committed unfinished work for ${issue.identifier}`)
        }
      } catch (err) {
        logger.warn("completion", "Safety-net check failed", {
          issueId: issue.id,
          error: String(err),
        })
      }

      // Get diff stat after auto-commit
      let diffStat: string | null = null
      if (hasCodeChanges) {
        try {
          diffStat = await workspaceManager.getDiffStat(workspace)
        } catch {
          /* best-effort */
        }
      }

      // ── Work summary ──
      try {
        const summary = buildWorkSummary(completedAttempt, { autoCommitted, diffStat })
        await addIssueComment(config.linearApiKey, issue.id, summary)
      } catch (err) {
        logger.warn("completion", "Failed to post work summary", {
          issueId: issue.id,
          error: String(err),
        })
      }

      // ── Delivery ──
      if (route.deliveryMode === "merge") {
        const mergeResult = await workspaceManager.mergeAndPush(workspace)
        if (!mergeResult.ok) {
          logger.error("completion", `Merge failed for ${issue.identifier}`, {
            error: mergeResult.error,
          })
          try {
            await addIssueComment(
              config.linearApiKey,
              issue.id,
              `Symphony: Merge failed — manual resolution required\n\n${mergeResult.error}`,
            )
          } catch {
            /* best-effort */
          }
        }

        try {
          await workspaceManager.cleanup(workspace)
        } catch (err) {
          logger.warn("completion", "Worktree cleanup failed", {
            issueId: issue.id,
            error: String(err),
          })
        }
      } else if (hasCodeChanges) {
        // pr mode: ensure branch is pushed so agent's PR (or manual PR) is possible
        try {
          await workspaceManager.pushBranch(workspace)
        } catch (err) {
          logger.warn("completion", "Branch push failed in PR mode", {
            issueId: issue.id,
            error: String(err),
          })
        }
      }

      // ── Exit assessment ──
      const hasOutput = (completedAttempt.agentOutput?.trim().length ?? 0) > 0
      let targetState = config.workflowStates.done

      if (!hasCodeChanges && !hasOutput) {
        // Agent produced nothing — likely premature exit or misunderstood issue
        targetState = config.workflowStates.cancelled
        try {
          await addIssueComment(
            config.linearApiKey,
            issue.id,
            "Symphony: Agent exited without code changes or output.\n" +
              "  → Consider adding more detail to the issue description and retrying.",
          )
        } catch {
          /* best-effort */
        }
      }

      try {
        await updateIssueState(config.linearApiKey, issue.id, targetState)
      } catch (err) {
        logger.error("completion", "Failed to transition issue state", {
          issueId: issue.id,
          error: String(err),
        })
      }

      const durationMs = Date.now() - new Date(attempt.startedAt).getTime()
      deps.emitEvent("agent.done", {
        issueKey: issue.identifier,
        issueId: issue.id,
        durationMs,
        autoCommitted,
      })

      logger.info("completion", `Agent completed for ${issue.identifier}`, {
        issueId: issue.id,
        exitCode: completedAttempt.exitCode ?? undefined,
        durationMs,
        autoCommitted,
        hasCodeChanges,
      })

      await deps.fillVacantSlots()
    },

    onError: async (err) => {
      deps.cleanupState(issue.id, "failed")

      deps.emitEvent("agent.failed", {
        issueKey: issue.identifier,
        issueId: issue.id,
        error: { code: err.code, message: err.message, retryable: err.recoverable },
      })

      logger.warn("completion", `Agent failed for ${issue.identifier}`, {
        issueId: issue.id,
        error: err.message,
      })

      if (err.recoverable) {
        const added = deps.addRetry(issue.id, 1, err.message)
        if (!added) {
          // Max retries exceeded — cancel issue with error comment
          try {
            await addIssueComment(
              config.linearApiKey,
              issue.id,
              `Symphony: Agent failed (${config.agentMaxRetries} retries exceeded)\n\nError: ${err.message}`,
            )
          } catch {
            /* best-effort */
          }
          try {
            await updateIssueState(config.linearApiKey, issue.id, config.workflowStates.cancelled)
          } catch (stateErr) {
            logger.error("completion", "Failed to transition to Cancelled", {
              issueId: issue.id,
              error: String(stateErr),
            })
          }
        }
      }

      await deps.fillVacantSlots()
    },

    onHeartbeat: (_timestamp) => {
      // Liveness tracking placeholder
    },
  }
}
