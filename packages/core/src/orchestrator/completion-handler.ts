/**
 * Completion Handler — Post-agent-completion logic extracted from Orchestrator.
 * Safety-net (auto-commit), delivery (merge/pr), and exit assessment.
 */

import type { ResolvedRoute } from "../config/routing"
import type { Config } from "../config/yaml-loader"
import type { Issue, RunAttempt, Workspace } from "../domain/models"
import type { IssueTracker } from "../domain/ports/tracker"
import type { WorkspaceGateway } from "../domain/ports/workspace"
import type { ObservabilityHooks } from "../observability/hooks"
import { createNoopObservabilityHooks } from "../observability/hooks"
import { logger } from "../observability/logger"
import type { RunCallbacks } from "./agent-runner"
import type { DagScheduler } from "./dag-scheduler"
import { buildParentSummary, buildWorkSummary } from "./helpers"

export interface CompletionDeps {
  config: Config
  workspace: WorkspaceGateway
  tracker: IssueTracker
  dagScheduler: DagScheduler
  /** Update orchestrator state on completion/failure. Orchestrator remains sole state authority. */
  cleanupState: (issueId: string, status: "done" | "failed") => void
  saveAttempt: (workspace: Workspace, attempt: RunAttempt) => void
  addRetry: (issueId: string, attemptCount: number, error: string) => boolean
  emitEvent: (event: string, payload: Record<string, unknown>) => void
  fillVacantSlots: () => Promise<void>
  triggerUnblocked: (issueIds: string[]) => Promise<void>
  /** Observability hooks (OTel + Prom). Defaults to no-op when omitted. */
  observability?: ObservabilityHooks
}

interface WorkspaceFailure {
  error: string
  retryable?: boolean
  retryPrompt?: string
}

export function createCompletionCallbacks(
  deps: CompletionDeps,
  issue: Issue,
  workspace: Workspace,
  attempt: RunAttempt,
  route: ResolvedRoute,
): RunCallbacks {
  const { config, workspace: wsGateway, tracker } = deps
  const observability = deps.observability ?? createNoopObservabilityHooks()

  const handleWorkspaceFailure = async (
    failure: WorkspaceFailure,
    options: {
      retryComment: string
      manualComment: string
    },
  ): Promise<boolean> => {
    const nextRetryCount = (attempt.retryCount ?? 0) + 1

    if (failure.retryable) {
      const retryAdded = deps.addRetry(issue.id, nextRetryCount, failure.retryPrompt ?? failure.error)
      deps.cleanupState(issue.id, "failed")

      try {
        await tracker.addIssueComment(
          issue.id,
          retryAdded ? `${options.retryComment}\n\n${failure.error}` : `${options.manualComment}\n\n${failure.error}`,
        )
      } catch (err) {
        logger.debug("completion", "Failed to post retryable workspace failure comment", {
          issueId: issue.id,
          error: String(err),
        })
      }

      if (!retryAdded) {
        try {
          await tracker.updateIssueState(issue.id, config.workflowStates.cancelled)
        } catch (err) {
          logger.error("completion", "Failed to transition retry-exhausted issue state", {
            issueId: issue.id,
            error: String(err),
          })
        }
      }

      await deps.fillVacantSlots()
      return true
    }

    deps.cleanupState(issue.id, "failed")
    try {
      await tracker.addIssueComment(issue.id, `${options.manualComment}\n\n${failure.error}`)
    } catch (err) {
      logger.debug("completion", "Failed to post workspace failure comment", {
        issueId: issue.id,
        error: String(err),
      })
    }
    try {
      await tracker.updateIssueState(issue.id, config.workflowStates.cancelled)
    } catch (err) {
      logger.error("completion", "Failed to transition blocked issue state", {
        issueId: issue.id,
        error: String(err),
      })
    }
    await deps.fillVacantSlots()
    return true
  }

  return {
    onComplete: async (completedAttempt) => {
      deps.cleanupState(issue.id, "done")
      deps.saveAttempt(workspace, completedAttempt)

      // ── Safety net: detect and rescue uncommitted agent work ──
      let autoCommitted = false
      let hasCodeChanges = false
      let autoCommitBlockedFailure: WorkspaceFailure | null = null

      try {
        const unfinished = await wsGateway.detectUnfinishedWork(workspace)
        hasCodeChanges = unfinished.hasCodeChanges

        if (unfinished.hasUncommittedChanges) {
          const commitResult = await wsGateway.autoCommit(workspace)
          autoCommitted = commitResult.ok
          if (autoCommitted) {
            hasCodeChanges = true
            logger.info("completion", `Auto-committed unfinished work for ${issue.identifier}`)
          } else {
            autoCommitBlockedFailure = {
              error: commitResult.error ?? "Auto-commit was blocked by workspace validation.",
              retryable: commitResult.retryable,
              retryPrompt: commitResult.retryPrompt,
            }
            logger.error("completion", `Auto-commit blocked for ${issue.identifier}`, {
              issueId: issue.id,
              error: autoCommitBlockedFailure.error,
            })
          }
        }
      } catch (err) {
        logger.warn("completion", "Safety-net check failed", {
          issueId: issue.id,
          error: String(err),
        })
      }

      if (autoCommitBlockedFailure) {
        await handleWorkspaceFailure(autoCommitBlockedFailure, {
          retryComment:
            "Symphony: Auto-commit blocked by regeneratable lockfile conflict — retrying with repair instructions.",
          manualComment: "Symphony: Auto-commit blocked — manual resolution required",
        })
        return
      }

      // Get diff stat after auto-commit
      let diffStat: string | null = null
      if (hasCodeChanges) {
        try {
          diffStat = await wsGateway.getDiffStat(workspace)
        } catch (err) {
          logger.debug("completion", "getDiffStat failed", { issueId: issue.id, error: String(err) })
        }
      }

      // ── Work summary ──
      try {
        const summary = buildWorkSummary(completedAttempt, { autoCommitted, diffStat })
        await tracker.addIssueComment(issue.id, summary)
      } catch (err) {
        logger.warn("completion", "Failed to post work summary", {
          issueId: issue.id,
          error: String(err),
        })
      }

      // ── Delivery ──
      if (route.deliveryMode === "merge") {
        const mergeResult = await wsGateway.mergeAndPush(workspace)
        if (!mergeResult.ok) {
          logger.error("completion", `Merge failed for ${issue.identifier}`, {
            error: mergeResult.error,
            retryable: mergeResult.retryable ?? false,
          })
          await handleWorkspaceFailure(
            {
              error: mergeResult.error ?? "Merge failed during delivery.",
              retryable: mergeResult.retryable,
              retryPrompt: mergeResult.retryPrompt,
            },
            {
              retryComment:
                "Symphony: Merge hit a regeneratable lockfile conflict — retrying with repair instructions.",
              manualComment: "Symphony: Merge failed — manual resolution required",
            },
          )
          return
        }

        try {
          await wsGateway.cleanup(workspace)
        } catch (err) {
          logger.warn("completion", "Worktree cleanup failed", {
            issueId: issue.id,
            error: String(err),
          })
        }
      } else if (hasCodeChanges) {
        // PR mode: push branch + safety-net draft PR creation
        try {
          await wsGateway.pushBranch(workspace)
          // Safety-net: create draft PR if agent didn't
          const prResult = await wsGateway.createDraftPR(workspace, {
            title: `${issue.identifier}: ${issue.title}`,
            body: completedAttempt.agentOutput
              ? `## Summary\n${completedAttempt.agentOutput.slice(0, 2000)}`
              : `Automated PR for ${issue.identifier}`,
          })
          if (prResult.created) {
            logger.info("completion", `Safety-net draft PR created for ${issue.identifier}`, { url: prResult.url })
          }
        } catch (err) {
          logger.warn("completion", "Branch push or PR creation failed in PR mode", {
            issueId: issue.id,
            error: String(err),
          })
        }
      }

      // ── Exit assessment ──
      const hasOutput = (completedAttempt.agentOutput?.trim().length ?? 0) > 0
      let targetState = config.workflowStates.done

      if (!hasCodeChanges && !hasOutput) {
        // Anti-premature-exit: retry once before giving up
        const prematureRetryAdded = deps.addRetry(issue.id, (completedAttempt.retryCount ?? 0) + 1, "premature-exit")
        if (prematureRetryAdded) {
          logger.warn("completion", `Agent exited without changes for ${issue.identifier}, scheduling retry`)
          deps.cleanupState(issue.id, "failed")
          try {
            await tracker.addIssueComment(
              issue.id,
              "Symphony: Agent exited without code changes — retrying with additional context.",
            )
          } catch (err) {
            logger.debug("completion", "Failed to post premature-exit comment", {
              issueId: issue.id,
              error: String(err),
            })
          }
          await deps.fillVacantSlots()
          return
        }

        // Retry exhausted — cancel
        targetState = config.workflowStates.cancelled
        try {
          await tracker.addIssueComment(
            issue.id,
            "Symphony: Agent exited without code changes after retry.\n" +
              "  → Consider adding more detail to the issue description.",
          )
        } catch (err) {
          logger.debug("completion", "Failed to post retry-exhausted comment", {
            issueId: issue.id,
            error: String(err),
          })
        }
      }

      try {
        await tracker.updateIssueState(issue.id, targetState)
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

      observability.onAgentDone({
        agentType: route.agentType,
        issueKey: issue.identifier,
        issueId: issue.id,
        attemptId: attempt.id,
        durationMs,
      })

      logger.info("completion", `Agent completed for ${issue.identifier}`, {
        issueId: issue.id,
        exitCode: completedAttempt.exitCode ?? undefined,
        durationMs,
        autoCommitted,
        hasCodeChanges,
      })

      // ── DAG cascade: unblock waiting issues ──
      deps.dagScheduler.updateNodeStatus(issue.id, "done")
      const unblocked = deps.dagScheduler.getUnblockedByCompletion(issue.id)
      if (unblocked.length > 0) {
        logger.info("completion", `${issue.identifier} completion unblocks ${unblocked.length} issue(s)`)
        await deps.triggerUnblocked(unblocked)
      }

      // ── DAG: parent auto-complete ──
      if (issue.parentId && deps.dagScheduler.allChildrenDone(issue.parentId)) {
        const children = deps.dagScheduler.getChildrenSummaries(issue.parentId)
        try {
          await tracker.addIssueComment(issue.parentId, buildParentSummary(children))
          await tracker.updateIssueState(issue.parentId, config.workflowStates.done)
          logger.info("completion", `Parent ${issue.parentId} auto-completed (all children done)`)
        } catch (err) {
          logger.warn("completion", "Failed to auto-complete parent", { parentId: issue.parentId, error: String(err) })
        }
      }

      await deps.fillVacantSlots()
    },

    onError: async (err) => {
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

      logger.warn("completion", `Agent failed for ${issue.identifier}`, {
        issueId: issue.id,
        error: err.message,
      })

      if (err.recoverable) {
        const added = deps.addRetry(issue.id, (attempt.retryCount ?? 0) + 1, err.message)
        if (!added) {
          // Max retries exceeded — cancel issue with error comment
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
          try {
            await tracker.updateIssueState(issue.id, config.workflowStates.cancelled)
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
