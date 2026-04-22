/**
 * Orchestrator — Core Symphony component.
 * Webhook-driven event handler, state machine, retry queue.
 * Sole authority over in-memory runtime state.
 */

import { resolveRouteWithScore } from "../config/routing"
import { renderPrompt } from "../config/workflow-loader"
import type { Config } from "../config/yaml-loader"
import type { Issue, OrchestratorRuntimeState, RunAttempt, Workspace } from "../domain/models"
import type { IssueTracker, WebhookReceiver } from "../domain/ports/tracker"
import type { WorkspaceGateway } from "../domain/ports/workspace"
import { logger } from "../observability/logger"
import type { ParsedWebhookEvent } from "../tracker/types"
import { AgentRunnerService } from "./agent-runner"
import { type CompletionDeps, createCompletionCallbacks } from "./completion-handler"
import { DagScheduler } from "./dag-scheduler"
import { OrchestratorEventEmitter } from "./event-emitter"
import { buildOrchestratorStatus, sortByIssueNumber } from "./helpers"
import { RetryQueue } from "./retry-queue"
import { analyzeScoreInBackground } from "./scoring-service"

interface RetryContext {
  attemptCount: number
  lastError: string
}

export class Orchestrator extends OrchestratorEventEmitter {
  private state: OrchestratorRuntimeState = {
    isRunning: false,
    activeWorkspaces: new Map(),
    waitingIssues: new Map(),
    lastEventAt: null,
  }

  private agentRunner: AgentRunnerService
  private retryQueue: RetryQueue
  private dagScheduler: DagScheduler
  private completionDeps: CompletionDeps
  private retryTimer: ReturnType<typeof setInterval> | null = null
  private promptTemplate: string = ""
  private startupSyncCompleted = false
  private startupSyncInFlight = false

  /** Guards against TOCTOU race: tracks issues currently being processed (between check and activeWorkspaces.set). */
  private processingIssues = new Set<string>()

  /** Maps issueId -> attemptId for active agent sessions, enabling kill on left-in-progress. */
  private activeAttempts = new Map<string, string>()

  constructor(
    private config: Config,
    private tracker: IssueTracker,
    private webhook: WebhookReceiver<ParsedWebhookEvent>,
    private workspace: WorkspaceGateway,
  ) {
    super()
    this.agentRunner = new AgentRunnerService()
    this.retryQueue = new RetryQueue(config.agentMaxRetries, config.agentRetryDelay)
    this.dagScheduler = new DagScheduler(`${config.workspaceRoot}/.agent-valley/dag-cache.json`)
    this.completionDeps = {
      config,
      workspace: this.workspace,
      tracker: this.tracker,
      dagScheduler: this.dagScheduler,
      cleanupState: (issueId, status) => {
        const ws = this.state.activeWorkspaces.get(issueId)
        if (ws) ws.status = status
        this.state.activeWorkspaces.delete(issueId)
        this.activeAttempts.delete(issueId)
      },
      saveAttempt: (ws, att) => this.workspace.saveAttempt(ws, att),
      addRetry: (issueId, count, error) => this.retryQueue.add(issueId, count, error),
      emitEvent: (event, payload) => this.emitEvent(event, payload),
      fillVacantSlots: () => this.fillVacantSlots(),
      triggerUnblocked: async (issueIds) => {
        for (const id of issueIds) {
          this.state.waitingIssues.delete(id)
        }
        await this.reevaluateWaitingIssues()
      },
    }
  }

  async start(): Promise<void> {
    this.state.isRunning = true

    // Load prompt template from config (valley.yaml)
    this.promptTemplate = this.config.promptTemplate

    // Startup sync — run in background so server starts immediately
    const runStartupSync = async () => {
      await new Promise((r) => setTimeout(r, 2_000))
      await this.ensureStartupSync()
    }
    void runStartupSync()

    // Periodic retry queue processing
    this.retryTimer = setInterval(() => {
      void this.processRetryQueue()
      if (!this.startupSyncCompleted) {
        void this.ensureStartupSync()
      }
    }, 30_000)

    this.emitEvent("node.join", {
      defaultAgentType: this.config.agentType,
      maxParallel: this.config.maxParallel,
      displayName: this.config.displayName ?? this.config.agentType,
    })

    logger.info("orchestrator", "Symphony started", {
      agentType: this.config.agentType,
      maxParallel: String(this.config.maxParallel),
    })
  }

  async stop(): Promise<void> {
    logger.info("orchestrator", "Shutting down gracefully...")
    this.emitEvent("node.leave", { reason: "graceful" })
    this.state.isRunning = false

    if (this.retryTimer) clearInterval(this.retryTimer)

    // Wait for active agents to complete
    await this.agentRunner.killAll()

    logger.info("orchestrator", "Shutdown complete")
  }

  /**
   * Returns handler callbacks for the Presentation layer to wire into the HTTP server.
   * This keeps the Application layer free of Presentation imports.
   */
  getHandlers(): {
    onWebhook: (payload: string, signature: string) => Promise<{ status: number; body: string }>
    getStatus: () => Record<string, unknown>
  } {
    return {
      onWebhook: (payload, signature) => this.handleWebhook(payload, signature),
      getStatus: () => this.getStatus(),
    }
  }

  private async startupSync(): Promise<void> {
    const issues = await this.tracker.fetchIssuesByState([
      this.config.workflowStates.todo,
      this.config.workflowStates.inProgress,
    ])
    await this.dagScheduler.reconcileWithLinear(issues)
    sortByIssueNumber(issues)
    logger.info("orchestrator", `Startup sync completed, found ${issues.length} issues`)
    for (const issue of issues) {
      if (issue.status.id === this.config.workflowStates.todo) await this.handleIssueTodo(issue)
      else await this.handleIssueInProgress(issue)
    }
  }

  private async ensureStartupSync(): Promise<void> {
    if (this.startupSyncCompleted || this.startupSyncInFlight) return

    this.startupSyncInFlight = true
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await this.startupSync()
          this.startupSyncCompleted = true
          return
        } catch (err) {
          const cause = err instanceof Error && "cause" in err && err.cause ? `; cause=${String(err.cause)}` : ""
          if (attempt < 3) {
            logger.warn("orchestrator", `Startup sync attempt ${attempt} failed, retrying in 3s...`, {
              error: `${String(err)}${cause}`,
            })
            await new Promise((r) => setTimeout(r, 3_000))
          } else {
            logger.error("orchestrator", "Startup sync failed after 3 attempts", {
              error: `${String(err)}${cause}`,
              stack: err instanceof Error ? err.stack : undefined,
            })
          }
        }
      }
    } finally {
      this.startupSyncInFlight = false
    }
  }

  private async fillVacantSlots(): Promise<void> {
    const available = this.config.maxParallel - this.agentRunner.activeCount
    if (available <= 0) return

    try {
      const issues = await this.tracker.fetchIssuesByState([this.config.workflowStates.todo])

      sortByIssueNumber(issues)

      let filled = 0
      for (const issue of issues) {
        if (filled >= available) break
        const guard = this.canAcceptIssue(issue.id)
        if (!guard.ok) continue
        await this.handleIssueTodo(issue)
        filled++
      }

      if (filled > 0) {
        logger.info("orchestrator", `Filled ${filled} vacant slot(s)`, {
          activeCount: String(this.agentRunner.activeCount),
          maxParallel: String(this.config.maxParallel),
        })
      }
    } catch (err) {
      logger.error("orchestrator", "Failed to fill vacant slots", { error: String(err) })
    }
  }

  private async handleWebhook(payload: string, signature: string): Promise<{ status: number; body: string }> {
    // Verify signature
    const valid = await this.webhook.verifySignature(payload, signature)
    if (!valid) {
      logger.warn("orchestrator", "Webhook signature invalid")
      return { status: 403, body: '{"error":"Invalid signature"}' }
    }

    // Parse event
    const event = this.webhook.parseEvent(payload)
    if (!event) {
      return { status: 200, body: '{"ok":true,"skipped":"not an issue event"}' }
    }

    this.state.lastEventAt = new Date().toISOString()

    // Route relation events (DAG updates)
    if ("kind" in event && event.kind === "relation") {
      logger.debug("orchestrator", `Relation webhook: ${event.action} ${event.relationType}`, {
        issueId: event.issueId,
        relatedIssueId: event.relatedIssueId,
      })
      if (event.action === "create") {
        this.dagScheduler.addRelation(event.issueId, event.relatedIssueId, event.relationType)
      } else if (event.action === "remove") {
        this.dagScheduler.removeRelation(event.issueId, event.relatedIssueId)
        await this.reevaluateWaitingIssues()
      }
      return { status: 200, body: '{"ok":true}' }
    }

    logger.debug("orchestrator", `Webhook received: ${event.action} for ${event.issue.identifier}`, {
      issueId: event.issueId,
    })

    // Route issue events
    if (event.stateId === this.config.workflowStates.todo) {
      // Instant acknowledgment — webhook-triggered only (not startup sync or retry)
      if (!this.processingIssues.has(event.issueId) && !this.state.activeWorkspaces.has(event.issueId)) {
        this.tracker
          .addIssueComment(event.issueId, `Symphony: Received — starting agent for ${event.issue.identifier}`)
          .catch((err) => {
            logger.debug("orchestrator", "Failed to post webhook ack comment", { error: String(err) })
          })
      }
      await this.handleIssueTodo(event.issue)
    } else if (event.stateId === this.config.workflowStates.inProgress) {
      await this.handleIssueInProgress(event.issue)
    } else if (event.prevStateId === this.config.workflowStates.inProgress) {
      await this.handleIssueLeftInProgress(event.issueId)
    }

    // Process retry queue after each event
    await this.processRetryQueue()

    return { status: 200, body: '{"ok":true}' }
  }

  private canAcceptIssue(issueId: string): { ok: boolean; reason?: string } {
    if (this.processingIssues.has(issueId) || this.state.activeWorkspaces.has(issueId)) {
      return { ok: false, reason: "already active or being processed" }
    }
    if (this.agentRunner.activeCount >= this.config.maxParallel) {
      return { ok: false, reason: "concurrency limit reached" }
    }
    return { ok: true }
  }

  /** Try to accept an issue; if at concurrency limit, queue for retry. Returns true if accepted. */
  private tryAcceptOrQueue(issueId: string): boolean {
    const guard = this.canAcceptIssue(issueId)
    if (guard.ok) return true
    if (guard.reason === "concurrency limit reached") {
      this.retryQueue.add(issueId, 0, "Concurrency limit reached")
    }
    return false
  }

  private async handleIssueTodo(issue: Issue, retryContext?: RetryContext): Promise<void> {
    // DAG: check if issue has unresolved blockers
    const blockers = this.dagScheduler.getUnresolvedBlockers(issue.id)
    if (blockers.length > 0 && !this.state.waitingIssues.has(issue.id)) {
      this.state.waitingIssues.set(issue.id, {
        issueId: issue.id,
        identifier: issue.identifier,
        blockedBy: blockers,
        enqueuedAt: new Date().toISOString(),
      })
      this.tracker
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

    if (!this.tryAcceptOrQueue(issue.id)) return

    // Lock: mark as processing to prevent TOCTOU races
    this.processingIssues.add(issue.id)

    // Transition Todo -> In Progress on Linear
    try {
      await this.tracker.updateIssueState(issue.id, this.config.workflowStates.inProgress)
      logger.info("orchestrator", `Transitioned ${issue.identifier} from Todo to In Progress`)
    } catch (err) {
      this.processingIssues.delete(issue.id)
      logger.error("orchestrator", "Failed to transition issue to In Progress", {
        issueId: issue.id,
        error: String(err),
      })
      this.retryQueue.add(issue.id, 0, `State transition failed: ${err}`)
      return
    }

    // Update local issue status and delegate to In Progress handler
    // Note: handleIssueInProgress will inherit the processingIssues lock
    issue.status = { ...issue.status, id: this.config.workflowStates.inProgress, name: "In Progress" }
    await this.handleIssueInProgressInternal(issue, retryContext)
  }

  private async handleIssueInProgress(issue: Issue, retryContext?: RetryContext): Promise<void> {
    if (!this.tryAcceptOrQueue(issue.id)) return
    this.processingIssues.add(issue.id)
    await this.handleIssueInProgressInternal(issue, retryContext)
  }

  /**
   * Internal handler that does workspace creation + agent spawn.
   * Caller must have already added issue.id to processingIssues.
   */
  private async handleIssueInProgressInternal(issue: Issue, retryContext?: RetryContext): Promise<void> {
    // Fallback: if webhook didn't include labels and routing rules exist, fetch from API
    if ((!issue.labels || issue.labels.length === 0) && this.config.routingRules.length > 0) {
      try {
        issue.labels = await this.tracker.fetchIssueLabels(issue.id)
      } catch (err) {
        logger.warn("orchestrator", "Failed to fetch issue labels for routing, using default", {
          issueId: issue.id,
          error: String(err),
        })
      }
    }

    // Resolve routing: which repo, agent, and delivery mode for this issue
    const route = resolveRouteWithScore(issue, this.config)
    if (route.matchedLabel) {
      logger.info("orchestrator", `Routing ${issue.identifier} via label "${route.matchedLabel}"`, {
        workspaceRoot: route.workspaceRoot,
        agentType: route.agentType,
      })
    }

    // Background scoring: if no score yet and score routing is configured, analyze async.
    // Current run uses defaultAgentType; score label takes effect on subsequent runs.
    if (issue.score === null && this.config.scoreRouting && this.config.scoringModel) {
      const tracker = this.tracker
      analyzeScoreInBackground(issue, this.config.scoringModel, async (issueId, score) => {
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
      workspace = await this.workspace.create(issue, route.workspaceRoot)
    } catch (err) {
      this.processingIssues.delete(issue.id)
      logger.error("orchestrator", "Failed to create workspace", { issueId: issue.id, error: String(err) })
      this.retryQueue.add(issue.id, 0, `Workspace creation failed: ${err}`)
      return
    }

    workspace.status = "running"
    this.state.activeWorkspaces.set(issue.id, workspace)

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

    // Track attempt for kill-on-left-in-progress
    this.activeAttempts.set(issue.id, attempt.id)

    // Now that activeWorkspaces is set, release the processing lock
    this.processingIssues.delete(issue.id)

    // Render prompt
    const prompt = renderPrompt(
      this.promptTemplate,
      issue,
      workspace.path,
      attempt,
      retryContext?.attemptCount ?? 0,
      retryContext?.lastError ?? "",
    )

    this.emitEvent("agent.start", {
      agentType: route.agentType,
      issueKey: issue.identifier,
      issueId: issue.id,
    })

    const callbacks = createCompletionCallbacks(this.completionDeps, issue, workspace, attempt, route)

    // Spawn agent (using per-issue resolved agent type)
    await this.agentRunner.spawn(
      attempt,
      {
        agentType: route.agentType,
        timeout: this.config.agentTimeout,
        prompt,
        workspacePath: workspace.path,
      },
      callbacks,
    )

    logger.info("orchestrator", `Starting agent for ${issue.identifier}`, { issueId: issue.id })
  }

  private async handleIssueLeftInProgress(issueId: string): Promise<void> {
    const workspace = this.state.activeWorkspaces.get(issueId)
    if (!workspace) return

    logger.info("orchestrator", "Issue moved out of In Progress, stopping agent", { issueId })

    // Kill the running agent session
    const attemptId = this.activeAttempts.get(issueId)
    if (attemptId) {
      await this.agentRunner.kill(attemptId)
      this.activeAttempts.delete(issueId)
    }

    this.state.activeWorkspaces.delete(issueId)
    this.retryQueue.remove(issueId)

    // DAG: mark as cancelled and notify blocked issues
    this.dagScheduler.updateNodeStatus(issueId, "cancelled")
    for (const b of this.dagScheduler.getBlockedIssues(issueId)) {
      this.tracker
        .addIssueComment(b.issueId, `Symphony: Blocker ${b.identifier} was cancelled. Manual review needed.`)
        .catch((err) => {
          logger.debug("orchestrator", "Failed to post blocker-cancelled comment", { error: String(err) })
        })
    }
  }

  /** Re-evaluate waiting issues after a relation removal or blocker completion. */
  private async reevaluateWaitingIssues(): Promise<void> {
    const unblockedIds = [...this.state.waitingIssues.keys()].filter(
      (id) => this.dagScheduler.getUnresolvedBlockers(id).length === 0,
    )
    if (unblockedIds.length === 0) return

    const issues = await this.tracker.fetchIssuesByState([this.config.workflowStates.todo]).catch(() => [] as Issue[])

    for (const id of unblockedIds) {
      const entry = this.state.waitingIssues.get(id)
      this.state.waitingIssues.delete(id)
      const issue = issues.find((i) => i.id === id)
      if (issue) {
        logger.info("orchestrator", `${entry?.identifier ?? id} unblocked, dispatching`)
        await this.handleIssueTodo(issue)
      }
    }
  }

  private async processRetryQueue(): Promise<void> {
    const ready = this.retryQueue.drain()
    if (ready.length === 0) return
    let issues: Issue[] = []
    try {
      issues = await this.tracker.fetchIssuesByState([
        this.config.workflowStates.todo,
        this.config.workflowStates.inProgress,
      ])
    } catch (err) {
      logger.warn("orchestrator", "Retry fetch failed, re-queuing entries", { error: String(err) })
      for (const entry of ready) this.retryQueue.add(entry.issueId, entry.attemptCount, entry.lastError)
      return
    }
    for (const entry of ready) {
      const issue = issues.find((i) => i.id === entry.issueId)
      if (issue) {
        const retryContext = {
          attemptCount: entry.attemptCount,
          lastError: entry.lastError,
        }
        if (issue.status.id === this.config.workflowStates.todo) await this.handleIssueTodo(issue, retryContext)
        else await this.handleIssueInProgress(issue, retryContext)
      } else {
        logger.info("orchestrator", "Retry issue no longer in Todo/InProgress, dropping", { issueId: entry.issueId })
      }
    }
  }

  private getStatus(): Record<string, unknown> {
    return buildOrchestratorStatus(this.state, this.activeAttempts, this.agentRunner, this.retryQueue, this.config)
  }
}
