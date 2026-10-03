import type { ResolvedRoute } from "../config/routing"
import type { Config } from "../config/yaml-loader"
import type { Issue, RetryCategory, RunAttempt, Workspace } from "../domain/models"
import type { IssueTracker } from "../domain/ports/tracker"
import type { WorkspaceGateway } from "../domain/ports/workspace"
import type { ObservabilityHooks } from "../observability/hooks"
import { createNoopObservabilityHooks } from "../observability/hooks"
import { logger } from "../observability/logger"
import { type OmaEvidenceRequest, type OmaEvidenceResult, validateOmaEvidence } from "../oma/receipt-adapter"
import type { RunCallbacks } from "./agent-runner"
import { validateAnalysisArtifact } from "./analysis-artifact"
import type { BudgetService } from "./budget-service"
import { handleAgentFailure } from "./completion-error"
import { recordBudgetUsage } from "./completion-usage"
import type { DagScheduler } from "./dag-scheduler"
import { buildWorkSummary } from "./helpers"
import type { PersistedFinalization } from "./persistence/run-state-store"
import { buildVerificationFailurePrompt, resolveVerifyCommand, runVerificationGate } from "./verification-gate"

export interface CompletionDeps {
  config: Config
  workspace: WorkspaceGateway
  tracker: IssueTracker
  dagScheduler: DagScheduler
  /** Update orchestrator state on completion/failure. Orchestrator remains sole state authority. */
  cleanupState: (issueId: string, status: "done" | "failed") => void
  saveAttempt: (workspace: Workspace, attempt: RunAttempt) => void | Promise<void>
  /** `category` (see `RetryCategory`) drives RetryQueue's per-category max-attempts policy. Defaults to "infra" when omitted. */
  addRetry: (issueId: string, attemptCount: number, error: string, category?: RetryCategory) => boolean
  emitEvent: (event: string, payload: Record<string, unknown>) => void
  fillVacantSlots: () => Promise<void>
  triggerUnblocked: (issueIds: string[]) => Promise<void>
  /** Observability hooks (OTel + Prom). Defaults to no-op when omitted. */
  observability?: ObservabilityHooks
  budget?: BudgetService
  /** Additional operator evidence gate for configured analysis tasks. */
  assessNoCodeOutcome?: (issue: Issue, attempt: RunAttempt) => Promise<boolean> | boolean
  omaEvidence?: (request: OmaEvidenceRequest) => OmaEvidenceResult | Promise<OmaEvidenceResult>
  finalizeDelivered: (record: PersistedFinalization) => Promise<void>
}

interface WorkspaceFailure {
  error: string
  retryable?: boolean
  retryPrompt?: string
  category?: RetryCategory
}

export function createCompletionCallbacks(
  deps: CompletionDeps,
  issue: Issue,
  workspace: Workspace,
  attempt: RunAttempt,
  route: ResolvedRoute,
): RunCallbacks {
  const { config, workspace: wsGateway, tracker } = deps
  const task = route.task ?? config.task ?? { kind: "code" }
  const observability = deps.observability ?? createNoopObservabilityHooks()
  let handled = false
  const saveAttempt = async (result: RunAttempt): Promise<void> => {
    try {
      await deps.saveAttempt(workspace, result)
    } catch (err) {
      logger.error("completion", "Failed to persist run attempt", { attemptId: result.id, error: String(err) })
    }
  }

  const handleWorkspaceFailure = async (
    failure: WorkspaceFailure,
    options: {
      retryComment: string
      manualComment: string
      /** Failure classification for the retry-queue policy. Defaults to "infra" (all current call sites are environmental: lockfile conflicts, verify_command failures). */
      category?: RetryCategory
    },
  ): Promise<boolean> => {
    const nextRetryCount = (attempt.retryCount ?? 0) + 1

    if (failure.retryable) {
      const retryAdded = deps.addRetry(
        issue.id,
        nextRetryCount,
        failure.retryPrompt ?? failure.error,
        options.category ?? "infra",
      )
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
          deps.dagScheduler.updateNodeStatus(issue.id, "cancelled")
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
      deps.dagScheduler.updateNodeStatus(issue.id, "cancelled")
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
      if (handled) return
      handled = true
      let attemptRecorded = false
      const recordCompletedAttempt = async (): Promise<void> => {
        if (attemptRecorded) return
        attemptRecorded = true
        await recordBudgetUsage(deps.budget, completedAttempt, issue.id)
        await saveAttempt(completedAttempt)
      }
      // In strict mode, receipt validation must run before attempt metadata
      // or budget persistence can alter the fingerprinted worktree.
      if (config.oma?.mode !== "strict") await recordCompletedAttempt()

      // ── Safety net: detect and rescue uncommitted agent work ──
      let autoCommitted = false
      let hasCodeChanges = false
      let verifiedAnalysis = false
      let autoCommitBlockedFailure: WorkspaceFailure | null = null

      try {
        const unfinished = await wsGateway.detectUnfinishedWork(workspace)
        hasCodeChanges = unfinished.hasCodeChanges

        if (config.oma?.mode === "strict") {
          if (unfinished.hasUncommittedChanges) {
            autoCommitBlockedFailure = {
              error: "Strict OMA completion requires committed work before receipt verification.",
              retryable: true,
              category: "capability",
            }
          } else {
            const evidence = await (deps.omaEvidence ?? validateOmaEvidence)({
              issue,
              attempt: completedAttempt,
              workspace,
              agentId: route.agentType,
              verifyCommand: resolveVerifyCommand(config, route) ?? "",
              kind: task.kind,
              reportPath: task.kind === "analysis" ? task.reportPath : undefined,
            })
            if (!evidence.ok) {
              autoCommitBlockedFailure = {
                error: `OMA completion evidence rejected: ${evidence.reason ?? "unknown validation failure"}`,
                retryable: true,
                category: "capability",
              }
            } else {
              verifiedAnalysis = !hasCodeChanges
            }
          }
          await recordCompletedAttempt()
        }

        if (unfinished.hasUncommittedChanges && !autoCommitBlockedFailure) {
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
        await recordCompletedAttempt()
        logger.error("completion", "Safety-net check failed", {
          issueId: issue.id,
          error: String(err),
        })
        autoCommitBlockedFailure = { error: `Could not inspect unfinished work: ${String(err)}`, retryable: true }
      }

      if (autoCommitBlockedFailure) {
        const evidenceFailure = autoCommitBlockedFailure.category === "capability"
        await handleWorkspaceFailure(autoCommitBlockedFailure, {
          retryComment: evidenceFailure
            ? "Symphony: OMA completion evidence rejected — retrying with repair instructions."
            : "Symphony: Auto-commit blocked by regeneratable lockfile conflict — retrying with repair instructions.",
          manualComment: evidenceFailure
            ? "Symphony: OMA completion evidence rejected — manual resolution required"
            : "Symphony: Auto-commit blocked — manual resolution required",
          category: autoCommitBlockedFailure.category ?? "infra",
        })
        return
      }

      if (task.kind === "analysis" && hasCodeChanges) {
        await handleWorkspaceFailure(
          {
            error: "Analysis task produced code changes; configure task.kind: code in av.yaml for code delivery.",
            retryable: true,
          },
          {
            retryComment: "Symphony: Task kind and output differ.",
            manualComment: "Symphony: Task kind and output differ.",
            category: "capability",
          },
        )
        return
      }

      let diffStat: string | null = null
      if (hasCodeChanges) {
        try {
          diffStat = await wsGateway.getDiffStat(workspace)
        } catch (err) {
          logger.debug("completion", "getDiffStat failed", { issueId: issue.id, error: String(err) })
        }
      }

      try {
        const summary = buildWorkSummary(completedAttempt, { autoCommitted, diffStat })
        await tracker.addIssueComment(issue.id, summary)
      } catch (err) {
        logger.warn("completion", "Failed to post work summary", {
          issueId: issue.id,
          error: String(err),
        })
      }

      // ── Verification gate ── Runs verify_command before delivery/Done when
      // OMA strict mode has not already validated the same pinned check.
      if (hasCodeChanges && config.oma?.mode !== "strict") {
        const verifyCommand = resolveVerifyCommand(config, route)
        if (!verifyCommand) {
          await handleWorkspaceFailure(
            {
              error: "Code completion requires verify.command or routing.rules[].verify_command in av.yaml.",
              retryable: true,
            },
            {
              retryComment: "Symphony: Verification is not configured.",
              manualComment: "Symphony: Configure verification before delivery.",
              category: "verification",
            },
          )
          return
        }
        {
          const gateResult = await runVerificationGate(workspace, verifyCommand, {
            timeoutSec: config.verify?.timeoutSec,
          })
          if (!gateResult.ok) {
            logger.warn("completion", `Verification gate failed for ${issue.identifier}`, {
              issueId: issue.id,
              command: verifyCommand,
              timedOut: gateResult.timedOut ?? false,
            })
            await handleWorkspaceFailure(
              {
                error: gateResult.timedOut
                  ? `Verification command timed out (${config.verify?.timeoutSec ?? "default"}s): ${verifyCommand}`
                  : `Verification command failed: ${verifyCommand}`,
                retryable: true,
                retryPrompt: buildVerificationFailurePrompt(gateResult),
              },
              {
                retryComment: "Symphony: Verification gate failed — retrying with the failure output below.",
                manualComment: "Symphony: Verification gate failed — manual resolution required",
                category: "verification",
              },
            )
            return
          }
          logger.info("completion", `Verification gate passed for ${issue.identifier}`, {
            issueId: issue.id,
            command: verifyCommand,
          })
        }
      }

      // ── Delivery ──
      if (route.deliveryMode === "merge" && hasCodeChanges) {
        let mergeResult: Awaited<ReturnType<WorkspaceGateway["mergeAndPush"]>>
        try {
          mergeResult = await wsGateway.mergeAndPush(workspace)
        } catch (err) {
          mergeResult = { ok: false, error: `Merge delivery failed: ${String(err)}`, retryable: true }
        }
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
              category: "infra", // regeneratable lockfile conflict — environmental, not agent capability
            },
          )
          return
        }
      } else if (hasCodeChanges) {
        // Retry only the failed delivery step. A successful push is not repeated
        // when PR creation or URL confirmation fails.
        let pushed = false
        let prUrl: string | undefined
        let deliveryError = "PR delivery was not confirmed"
        for (let deliveryAttempt = 0; deliveryAttempt < 3 && !prUrl; deliveryAttempt++) {
          if (!pushed) {
            try {
              const pushResult = await wsGateway.pushBranch(workspace)
              pushed = pushResult.ok
              if (!pushed) {
                deliveryError = pushResult.error ?? "Branch push failed"
                continue
              }
            } catch (err) {
              deliveryError = `Branch push failed: ${String(err)}`
              continue
            }
          }
          try {
            const prResult = await wsGateway.createDraftPR(workspace, {
              title: `${issue.identifier}: ${issue.title}`,
              body: completedAttempt.agentOutput
                ? `## Summary\n${completedAttempt.agentOutput.slice(0, 2000)}`
                : `Automated PR for ${issue.identifier}`,
            })
            if (prResult.url && /^https?:\/\/[^\s/]+\//.test(prResult.url)) {
              prUrl = prResult.url
              logger.info("completion", `PR confirmed for ${issue.identifier}`, { url: prUrl })
            }
          } catch (err) {
            deliveryError = `PR creation failed: ${String(err)}`
          }
        }
        if (!prUrl) {
          await handleWorkspaceFailure(
            { error: deliveryError },
            {
              retryComment: "Symphony: PR delivery failed — retrying delivery.",
              manualComment: "Symphony: PR delivery failed after three attempts — manual resolution required",
              category: "infra",
            },
          )
          return
        }
      }

      // ── Exit assessment ──
      let noCodeComplete = false
      if (!hasCodeChanges && task.kind === "analysis") {
        const artifact = await validateAnalysisArtifact(workspace, completedAttempt, task.reportPath)
        noCodeComplete = artifact.ok && (config.oma?.mode !== "strict" || verifiedAnalysis)
        if (!artifact.ok)
          logger.warn("completion", "Analysis artifact rejected", { issueId: issue.id, reason: artifact.reason })
      }
      if (noCodeComplete && deps.assessNoCodeOutcome) {
        try {
          noCodeComplete = await deps.assessNoCodeOutcome(issue, completedAttempt)
        } catch (err) {
          noCodeComplete = false
          logger.error("completion", "No-code completion assessment failed", { issueId: issue.id, error: String(err) })
        }
      }

      if (!hasCodeChanges && !noCodeComplete) {
        // Anti-premature-exit: retry once before giving up. "capability" — re-running an incapable attempt rarely helps.
        const prematureRetryAdded = deps.addRetry(
          issue.id,
          (completedAttempt.retryCount ?? 0) + 1,
          "premature-exit",
          "capability",
        )
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
        try {
          await tracker.updateIssueState(issue.id, config.workflowStates.cancelled)
          deps.dagScheduler.updateNodeStatus(issue.id, "cancelled")
        } catch (err) {
          logger.error("completion", "Failed to transition retry-exhausted issue state", {
            issueId: issue.id,
            error: String(err),
          })
        }
        deps.cleanupState(issue.id, "failed")
        await deps.fillVacantSlots()
        return
      }

      await deps.finalizeDelivered({
        issueId: issue.id,
        issueKey: issue.identifier,
        parentId: issue.parentId,
        attemptId: attempt.id,
        agentType: route.agentType,
        workspace,
        deliveryMode: route.deliveryMode,
        hasCodeChanges,
        autoCommitted,
        durationMs: Date.now() - new Date(attempt.startedAt).getTime(),
        tokenUsage: completedAttempt.tokenUsage,
      })
    },

    onError: async (err) => {
      if (handled) return
      handled = true
      const failedAttempt: RunAttempt = {
        ...attempt,
        finishedAt: new Date().toISOString(),
        exitCode: err.exitCode ?? null,
        tokenUsage: err.tokenUsage,
      }
      await recordBudgetUsage(deps.budget, failedAttempt, issue.id)
      await saveAttempt(failedAttempt)
      await handleAgentFailure(deps, issue, attempt, route, err, observability)
    },

    onHeartbeat: (_timestamp) => {
      // Liveness tracking placeholder
    },
  }
}
