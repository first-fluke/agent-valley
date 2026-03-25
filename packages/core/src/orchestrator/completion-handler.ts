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
import type { DagScheduler } from "./dag-scheduler"
import { buildParentSummary, buildWorkSummary } from "./helpers"

export interface CompletionDeps {
  config: Config
  workspaceManager: WorkspaceManager
  dagScheduler: DagScheduler
  /** Update orchestrator state on completion/failure. Orchestrator remains sole state authority. */
  cleanupState: (issueId: string, status: "done" | "failed") => void
  saveAttempt: (workspace: Workspace, attempt: RunAttempt) => void
  addRetry: (issueId: string, attemptCount: number, error: string) => boolean
  emitEvent: (event: string, payload: Record<string, unknown>) => void
  fillVacantSlots: () => Promise<void>
  triggerUnblocked: (issueIds: string[]) => Promise<void>
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

      let conflictBlocked = false

      try {
        const unfinished = await workspaceManager.detectUnfinishedWork(workspace)
        hasCodeChanges = unfinished.hasCodeChanges

        if (unfinished.hasUncommittedChanges) {
          const commitResult = await workspaceManager.autoCommit(workspace)

          // Conflict detection: abort delivery if conflicts found in uncommitted files
          if (commitResult.diagnostics) {
            conflictBlocked = true
            logger.error("completion", `Auto-commit blocked for ${issue.identifier}: conflict artifacts`, {
              issueId: issue.id,
              conflictFiles: commitResult.conflictFiles,
            })
            try {
              await addIssueComment(
                config.linearApiKey,
                issue.id,
                `Symphony: Auto-commit blocked — conflict artifacts detected\n\n${commitResult.diagnostics}\n\nRun failed. Manual resolution required.`,
              )
            } catch (commentErr) {
              logger.debug("completion", "Failed to post conflict diagnostics", {
                issueId: issue.id,
                error: String(commentErr),
              })
            }
          } else {
            autoCommitted = commitResult.ok
            if (autoCommitted) hasCodeChanges = true
            if (autoCommitted) logger.info("completion", `Auto-committed unfinished work for ${issue.identifier}`)
          }
        }
      } catch (err) {
        logger.warn("completion", "Safety-net check failed", {
          issueId: issue.id,
          error: String(err),
        })
      }

      // Pre-delivery validation: check branch for committed conflict markers
      if (!conflictBlocked && hasCodeChanges) {
        try {
          const branchCheck = await workspaceManager.validateBranchContent(workspace)
          if (!branchCheck.ok) {
            conflictBlocked = true
            logger.error("completion", `Delivery blocked for ${issue.identifier}: conflict markers in branch`, {
              issueId: issue.id,
              conflictFiles: branchCheck.conflictFiles,
            })
            try {
              await addIssueComment(
                config.linearApiKey,
                issue.id,
                `Symphony: Delivery blocked — conflict markers in committed files\n\n${branchCheck.diagnostics}\n\nRun failed. Manual resolution required.`,
              )
            } catch (commentErr) {
              logger.debug("completion", "Failed to post conflict diagnostics", {
                issueId: issue.id,
                error: String(commentErr),
              })
            }
          }
        } catch (err) {
          logger.warn("completion", "Branch validation failed", { issueId: issue.id, error: String(err) })
        }
      }

      // Get diff stat after auto-commit
      let diffStat: string | null = null
      if (hasCodeChanges) {
        try {
          diffStat = await workspaceManager.getDiffStat(workspace)
        } catch (err) {
          logger.debug("completion", "getDiffStat failed", { issueId: issue.id, error: String(err) })
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

      // ── Delivery (skipped when conflict-blocked) ──
      if (conflictBlocked) {
        try {
          await updateIssueState(config.linearApiKey, issue.id, config.workflowStates.cancelled)
        } catch (err) {
          logger.error("completion", "Failed to transition to Cancelled", { issueId: issue.id, error: String(err) })
        }
        if (route.deliveryMode === "merge") {
          try {
            await workspaceManager.cleanup(workspace)
          } catch (err) {
            logger.warn("completion", "Worktree cleanup failed", { issueId: issue.id, error: String(err) })
          }
        }
        deps.emitEvent("agent.done", {
          issueKey: issue.identifier,
          issueId: issue.id,
          durationMs: Date.now() - new Date(attempt.startedAt).getTime(),
          autoCommitted: false,
          conflictBlocked: true,
        })
        await deps.fillVacantSlots()
        return
      }

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
          } catch (err) {
            logger.debug("completion", "Failed to post merge failure comment", {
              issueId: issue.id,
              error: String(err),
            })
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
        // PR mode: push branch + safety-net draft PR creation
        try {
          await workspaceManager.pushBranch(workspace)
          // Safety-net: create draft PR if agent didn't
          const prResult = await workspaceManager.createDraftPR(workspace, {
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
        const prematureRetryAdded = deps.addRetry(
          issue.id,
          (completedAttempt.exitCode ?? 0) === 0 ? 1 : 2,
          "premature-exit",
        )
        if (prematureRetryAdded) {
          logger.warn("completion", `Agent exited without changes for ${issue.identifier}, scheduling retry`)
          deps.cleanupState(issue.id, "failed")
          try {
            await addIssueComment(
              config.linearApiKey,
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
          await addIssueComment(
            config.linearApiKey,
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
          await addIssueComment(config.linearApiKey, issue.parentId, buildParentSummary(children))
          await updateIssueState(config.linearApiKey, issue.parentId, config.workflowStates.done)
          logger.info("completion", `Parent ${issue.parentId} auto-completed (all children done)`)
        } catch (err) {
          logger.warn("completion", "Failed to auto-complete parent", { parentId: issue.parentId, error: String(err) })
        }
      }

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
          } catch (commentErr) {
            logger.debug("completion", "Failed to post max-retries comment", {
              issueId: issue.id,
              error: String(commentErr),
            })
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
