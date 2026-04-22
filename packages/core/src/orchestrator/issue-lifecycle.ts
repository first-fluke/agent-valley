/**
 * IssueLifecycle — Handles the state-transition side of orchestrator
 * event routing: Todo admission (DAG blocker check + Linear state
 * transition), In-Progress dispatch (workspace creation + agent spawn),
 * left-In-Progress kill, and post-blocker re-evaluation.
 *
 * Accesses runtime state only through OrchestratorCore's narrow API.
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 3.1 / § 5.3 (PR3).
 */

import { resolveRouteWithScore } from "../config/routing"
import { renderPrompt } from "../config/workflow-loader"
import type { Issue, RunAttempt, Workspace } from "../domain/models"
import { logger } from "../observability/logger"
import { createCompletionCallbacks } from "./completion-handler"
import type { OrchestratorCore } from "./orchestrator-core"
import { analyzeScoreInBackground } from "./scoring-service"

export interface RetryContext {
  attemptCount: number
  lastError: string
}

export class IssueLifecycle {
  constructor(private readonly core: OrchestratorCore) {}

  async handleIssueTodo(issue: Issue, retryContext?: RetryContext): Promise<void> {
    const { core } = this

    // DAG: check if issue has unresolved blockers
    const blockers = core.dagScheduler.getUnresolvedBlockers(issue.id)
    if (blockers.length > 0 && !core.hasWaitingIssue(issue.id)) {
      core.addWaitingIssue(issue.id, {
        issueId: issue.id,
        identifier: issue.identifier,
        blockedBy: blockers,
        enqueuedAt: new Date().toISOString(),
      })
      core.tracker
        .addIssueComment(
          issue.id,
          `Symphony: Waiting — blocked by ${blockers.length} issue(s). Will auto-start when dependencies complete.`,
        )
        .catch((err) => {
          logger.debug("orchestrator", "Failed to post blocker comment", { error: String(err) })
        })
      logger.info("orchestrator", `${issue.identifier} blocked by ${blockers.length} issue(s), waiting`)
      return
    }
    if (blockers.length > 0) return

    if (!core.tryAcceptOrQueue(issue.id)) return

    // Lock: mark as processing to prevent TOCTOU races
    core.markProcessing(issue.id)

    // Transition Todo -> In Progress on Linear
    try {
      await core.tracker.updateIssueState(issue.id, core.config.workflowStates.inProgress)
      logger.info("orchestrator", `Transitioned ${issue.identifier} from Todo to In Progress`)
    } catch (err) {
      core.releaseProcessing(issue.id)
      logger.error("orchestrator", "Failed to transition issue to In Progress", {
        issueId: issue.id,
        error: String(err),
      })
      core.enqueueRetry(issue.id, 0, `State transition failed: ${err}`)
      return
    }

    // Update local issue status and delegate to In Progress handler
    issue.status = { ...issue.status, id: core.config.workflowStates.inProgress, name: "In Progress" }
    await this.handleIssueInProgressInternal(issue, retryContext)
  }

  async handleIssueInProgress(issue: Issue, retryContext?: RetryContext): Promise<void> {
    if (!this.core.tryAcceptOrQueue(issue.id)) return
    this.core.markProcessing(issue.id)
    await this.handleIssueInProgressInternal(issue, retryContext)
  }

  private async handleIssueInProgressInternal(issue: Issue, retryContext?: RetryContext): Promise<void> {
    const { core } = this

    // Fallback: if webhook didn't include labels and routing rules exist, fetch from API
    if ((!issue.labels || issue.labels.length === 0) && core.config.routingRules.length > 0) {
      try {
        issue.labels = await core.tracker.fetchIssueLabels(issue.id)
      } catch (err) {
        logger.warn("orchestrator", "Failed to fetch issue labels for routing, using default", {
          issueId: issue.id,
          error: String(err),
        })
      }
    }

    // Resolve routing
    const route = resolveRouteWithScore(issue, core.config)
    if (route.matchedLabel) {
      logger.info("orchestrator", `Routing ${issue.identifier} via label "${route.matchedLabel}"`, {
        workspaceRoot: route.workspaceRoot,
        agentType: route.agentType,
      })
    }

    // Background scoring
    if (issue.score === null && core.config.scoreRouting && core.config.scoringModel) {
      const tracker = core.tracker
      analyzeScoreInBackground(issue, core.config.scoringModel, async (issueId, score) => {
        try {
          await tracker.addIssueLabel(issueId, `score:${score}`)
        } catch (err) {
          logger.warn("orchestrator", "Failed to attach score label", { issueId, error: String(err) })
        }
      })
    }

    // Create workspace in the resolved repo root
    let workspace: Workspace
    try {
      workspace = await core.workspace.create(issue, route.workspaceRoot)
    } catch (err) {
      core.releaseProcessing(issue.id)
      logger.error("orchestrator", "Failed to create workspace", { issueId: issue.id, error: String(err) })
      core.enqueueRetry(issue.id, 0, `Workspace creation failed: ${err}`)
      return
    }

    workspace.status = "running"
    core.addActiveWorkspace(issue.id, workspace)

    // Create attempt
    const attempt: RunAttempt = {
      id: crypto.randomUUID(),
      issueId: issue.id,
      workspacePath: workspace.path,
      retryCount: retryContext?.attemptCount ?? 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      agentOutput: null,
    }

    core.registerAttempt(issue.id, attempt.id)

    // Release the processing lock now that activeWorkspaces is set
    core.releaseProcessing(issue.id)

    // Render prompt
    const prompt = renderPrompt(
      core.getPromptTemplate(),
      issue,
      workspace.path,
      attempt,
      retryContext?.attemptCount ?? 0,
      retryContext?.lastError ?? "",
    )

    core.emitEvent("agent.start", {
      agentType: route.agentType,
      issueKey: issue.identifier,
      issueId: issue.id,
    })

    core.observability.onAgentStart({
      agentType: route.agentType,
      issueKey: issue.identifier,
      issueId: issue.id,
      attemptId: attempt.id,
    })

    const callbacks = createCompletionCallbacks(core.buildCompletionDeps(), issue, workspace, attempt, route)

    await core.agentRunner.spawn(
      attempt,
      {
        agentType: route.agentType,
        timeout: core.config.agentTimeout,
        prompt,
        workspacePath: workspace.path,
      },
      callbacks,
    )

    logger.info("orchestrator", `Starting agent for ${issue.identifier}`, { issueId: issue.id })
  }

  async handleIssueLeftInProgress(issueId: string): Promise<void> {
    const { core } = this
    const workspace = core.getActiveWorkspace(issueId)
    if (!workspace) return

    logger.info("orchestrator", "Issue moved out of In Progress, stopping agent", { issueId })

    const attemptId = core.getAttempt(issueId)
    if (attemptId) {
      await core.agentRunner.kill(attemptId)
      core.clearAttempt(issueId)
    }

    core.observability.onAgentCancelled({
      issueKey: workspace.key,
      issueId,
      attemptId,
    })

    core.removeActiveWorkspace(issueId)
    core.removeRetry(issueId)

    // DAG: mark as cancelled and notify blocked issues
    core.dagScheduler.updateNodeStatus(issueId, "cancelled")
    for (const b of core.dagScheduler.getBlockedIssues(issueId)) {
      core.tracker
        .addIssueComment(b.issueId, `Symphony: Blocker ${b.identifier} was cancelled. Manual review needed.`)
        .catch((err) => {
          logger.debug("orchestrator", "Failed to post blocker-cancelled comment", { error: String(err) })
        })
    }
  }

  /** Re-evaluate waiting issues after a relation removal or blocker completion. */
  async reevaluateWaitingIssues(): Promise<void> {
    const { core } = this
    const unblockedIds = core.waitingIssueIds().filter((id) => core.dagScheduler.getUnresolvedBlockers(id).length === 0)
    if (unblockedIds.length === 0) return

    const issues = await core.tracker.fetchIssuesByState([core.config.workflowStates.todo]).catch(() => [] as Issue[])

    for (const id of unblockedIds) {
      const entry = core.getWaitingEntry(id)
      core.deleteWaitingIssue(id)
      const issue = issues.find((i) => i.id === id)
      if (issue) {
        logger.info("orchestrator", `${entry?.identifier ?? id} unblocked, dispatching`)
        await this.handleIssueTodo(issue)
      }
    }
  }
}
