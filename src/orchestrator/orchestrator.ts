/**
 * Orchestrator — Core Symphony component.
 * Webhook-driven event handler, state machine, retry queue.
 * Sole authority over in-memory runtime state.
 */

import { readFile, access } from "node:fs/promises"
import type { Config } from "../config/env"
import type { Issue, Workspace, RunAttempt, OrchestratorRuntimeState } from "../domain/models"
import type { WebhookEvent } from "../tracker/types"
import { fetchIssuesByState, fetchIssueLabels, updateIssueState, addIssueComment, addIssueLabel } from "../tracker/linear-client"
import { verifyWebhookSignature, parseWebhookEvent } from "../tracker/webhook-handler"
import { WorkspaceManager } from "../workspace/workspace-manager"
import { AgentRunnerService } from "./agent-runner"
import { RetryQueue } from "./retry-queue"
import { parseWorkflow, renderPrompt } from "../config/workflow-loader"
import { resolveRouteWithScore } from "../config/routing"
import { analyzeScoreInBackground } from "./scoring-service"
import { buildWorkSummary, sortByIssueNumber } from "./helpers"
import { logger } from "../observability/logger"

type OrchestratorEventHandler = (...args: any[]) => void

export class Orchestrator {
  private state: OrchestratorRuntimeState = {
    isRunning: false,
    activeWorkspaces: new Map(),
    lastEventAt: null,
  }

  private workspaceManager: WorkspaceManager
  private agentRunner: AgentRunnerService
  private retryQueue: RetryQueue
  private retryTimer: ReturnType<typeof setInterval> | null = null
  private promptTemplate: string = ""

  /** Guards against TOCTOU race: tracks issues currently being processed (between check and activeWorkspaces.set). */
  private processingIssues = new Set<string>()

  /** Maps issueId -> attemptId for active agent sessions, enabling kill on left-in-progress. */
  private activeAttempts = new Map<string, string>()

  /** EventEmitter for team dashboard broadcasting */
  private eventListeners = new Map<string, Set<OrchestratorEventHandler>>()

  on(event: string, handler: OrchestratorEventHandler): void {
    const handlers = this.eventListeners.get(event) ?? new Set()
    handlers.add(handler)
    this.eventListeners.set(event, handlers)
  }

  off(event: string, handler: OrchestratorEventHandler): void {
    this.eventListeners.get(event)?.delete(handler)
  }

  private emitEvent(event: string, payload: Record<string, unknown>): void {
    const handlers = this.eventListeners.get(event)
    if (!handlers) return
    for (const handler of handlers) {
      try {
        handler(payload)
      } catch (err) {
        logger.warn("orchestrator", `Event handler error for ${event}`, { error: String(err) })
      }
    }
  }

  constructor(private config: Config) {
    this.workspaceManager = new WorkspaceManager(config.workspaceRoot)
    this.agentRunner = new AgentRunnerService()
    this.retryQueue = new RetryQueue(config.agentMaxRetries, config.agentRetryDelay)
  }

  async start(): Promise<void> {
    this.state.isRunning = true

    // Load WORKFLOW.md prompt template
    const workflowExists = await access("WORKFLOW.md").then(() => true).catch(() => false)
    if (!workflowExists) {
      throw new Error(
        "WORKFLOW.md not found in project root.\n" +
        "  Fix: Create WORKFLOW.md with YAML front matter (--- delimited) and a prompt template body.\n" +
        "  See AGENTS.md for the expected format."
      )
    }
    const workflowContent = await readFile("WORKFLOW.md", "utf-8")
    const { promptTemplate } = parseWorkflow(workflowContent)
    this.promptTemplate = promptTemplate

    // Startup sync — run in background so server starts immediately
    const runStartupSync = async () => {
      // Small delay to let the server bind first
      await new Promise((r) => setTimeout(r, 2_000))
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await this.startupSync()
          return
        } catch (err) {
          if (attempt < 3) {
            logger.warn("orchestrator", `Startup sync attempt ${attempt} failed, retrying in 3s...`)
            await new Promise((r) => setTimeout(r, 3_000))
          } else {
            logger.error("orchestrator", "Startup sync failed after 3 attempts", { error: String(err) })
          }
        }
      }
    }
    runStartupSync()

    // Periodic retry queue processing
    this.retryTimer = setInterval(() => this.processRetryQueue(), 30_000)

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

  // ── Startup Sync ──────────────────────────────────────────────────────

  private async startupSync(): Promise<void> {
    const issues = await fetchIssuesByState(
      this.config.linearApiKey,
      this.config.linearTeamUuid,
      [this.config.workflowStates.todo, this.config.workflowStates.inProgress],
    )

    sortByIssueNumber(issues)
    logger.info("orchestrator", `Startup sync completed, found ${issues.length} issues`)

    for (const issue of issues) {
      if (issue.status.id === this.config.workflowStates.todo) {
        await this.handleIssueTodo(issue)
      } else {
        await this.handleIssueInProgress(issue)
      }
    }
  }

  // ── Fill Vacant Slots ────────────────────────────────────────────────

  private async fillVacantSlots(): Promise<void> {
    const available = this.config.maxParallel - this.agentRunner.activeCount
    if (available <= 0) return

    try {
      const issues = await fetchIssuesByState(
        this.config.linearApiKey,
        this.config.linearTeamUuid,
        [this.config.workflowStates.todo],
      )

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

  // ── Webhook Handling ──────────────────────────────────────────────────

  private async handleWebhook(payload: string, signature: string): Promise<{ status: number; body: string }> {
    // Verify signature
    const valid = await verifyWebhookSignature(payload, signature, this.config.linearWebhookSecret)
    if (!valid) {
      logger.warn("orchestrator", "Webhook signature invalid")
      return { status: 403, body: '{"error":"Invalid signature"}' }
    }

    // Parse event
    const event = parseWebhookEvent(payload)
    if (!event) {
      return { status: 200, body: '{"ok":true,"skipped":"not an issue event"}' }
    }

    this.state.lastEventAt = new Date().toISOString()

    logger.debug("orchestrator", `Webhook received: ${event.action} for ${event.issue.identifier}`, {
      issueId: event.issueId,
    })

    // Route event
    if (event.stateId === this.config.workflowStates.todo) {
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

  // ── Concurrency Guard ─────────────────────────────────────────────────

  /**
   * Checks whether the orchestrator can accept a new issue for processing.
   * Combines duplicate check, processing-in-flight check, and concurrency limit.
   */
  private canAcceptIssue(issueId: string): { ok: boolean; reason?: string } {
    if (this.processingIssues.has(issueId) || this.state.activeWorkspaces.has(issueId)) {
      return { ok: false, reason: "already active or being processed" }
    }
    if (this.agentRunner.activeCount >= this.config.maxParallel) {
      return { ok: false, reason: "concurrency limit reached" }
    }
    return { ok: true }
  }

  // ── Issue Handling ────────────────────────────────────────────────────

  private async handleIssueTodo(issue: Issue): Promise<void> {
    const guard = this.canAcceptIssue(issue.id)
    if (!guard.ok) {
      if (guard.reason === "concurrency limit reached") {
        logger.warn("orchestrator", "Concurrency limit reached, keeping in Todo", {
          issueId: issue.id,
          activeCount: String(this.agentRunner.activeCount),
          maxParallel: String(this.config.maxParallel),
        })
        this.retryQueue.add(issue.id, 0, "Concurrency limit reached")
      } else {
        logger.debug("orchestrator", "Issue already active, skipping Todo", { issueId: issue.id })
      }
      return
    }

    // Lock: mark as processing to prevent TOCTOU races
    this.processingIssues.add(issue.id)

    // Transition Todo -> In Progress on Linear
    try {
      await updateIssueState(
        this.config.linearApiKey,
        issue.id,
        this.config.workflowStates.inProgress,
      )
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
    await this.handleIssueInProgressInternal(issue)
  }

  private async handleIssueInProgress(issue: Issue): Promise<void> {
    const guard = this.canAcceptIssue(issue.id)
    if (!guard.ok) {
      if (guard.reason === "concurrency limit reached") {
        logger.warn("orchestrator", "Concurrency limit reached, queuing", {
          issueId: issue.id,
          activeCount: String(this.agentRunner.activeCount),
          maxParallel: String(this.config.maxParallel),
        })
        this.retryQueue.add(issue.id, 0, "Concurrency limit reached")
      } else {
        logger.debug("orchestrator", "Issue already active, skipping", { issueId: issue.id })
      }
      return
    }

    // Lock: mark as processing to prevent TOCTOU races
    this.processingIssues.add(issue.id)
    await this.handleIssueInProgressInternal(issue)
  }

  /**
   * Internal handler that does workspace creation + agent spawn.
   * Caller must have already added issue.id to processingIssues.
   */
  private async handleIssueInProgressInternal(issue: Issue): Promise<void> {
    // Fallback: if webhook didn't include labels and routing rules exist, fetch from API
    if (issue.labels.length === 0 && this.config.routingRules.length > 0) {
      try {
        issue.labels = await fetchIssueLabels(this.config.linearApiKey, issue.id)
      } catch (err) {
        logger.warn("orchestrator", "Failed to fetch issue labels for routing, using default", {
          issueId: issue.id, error: String(err),
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
      const apiKey = this.config.linearApiKey
      const teamId = this.config.linearTeamUuid
      analyzeScoreInBackground(issue, this.config.scoringModel, async (issueId, score) => {
        try {
          await addIssueLabel(apiKey, teamId, issueId, `score:${score}`)
        } catch (err) {
          logger.warn("orchestrator", "Failed to attach score label", { issueId, error: String(err) })
        }
      })
    }

    // Create workspace in the resolved repo root
    let workspace: Workspace
    try {
      workspace = await this.workspaceManager.create(issue, route.workspaceRoot)
    } catch (err) {
      this.processingIssues.delete(issue.id)
      logger.error("orchestrator", "Failed to create workspace", { issueId: issue.id, error: String(err) })
      return
    }

    workspace.status = "running"
    this.state.activeWorkspaces.set(issue.id, workspace)

    // Create attempt
    const attempt: RunAttempt = {
      id: crypto.randomUUID(),
      issueId: issue.id,
      workspacePath: workspace.path,
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
    const prompt = renderPrompt(this.promptTemplate, issue, workspace.path, attempt, 0)

    this.emitEvent("agent.start", {
      agentType: route.agentType,
      issueKey: issue.identifier,
      issueId: issue.id,
    })

    // Spawn agent (using per-issue resolved agent type)
    await this.agentRunner.spawn(attempt, {
      agentType: route.agentType,
      timeout: this.config.agentTimeout,
      prompt,
      workspacePath: workspace.path,
    }, {
      onComplete: async (completedAttempt) => {
        const ws = this.state.activeWorkspaces.get(issue.id)
        if (ws) ws.status = "done"
        this.state.activeWorkspaces.delete(issue.id)
        this.activeAttempts.delete(issue.id)
        this.workspaceManager.saveAttempt(workspace, completedAttempt)

        // Post work summary comment (best-effort -- don't block Done transition)
        try {
          const summary = buildWorkSummary(completedAttempt)
          await addIssueComment(this.config.linearApiKey, issue.id, summary)
        } catch (err) {
          logger.warn("orchestrator", "Failed to post work summary comment", {
            issueId: issue.id,
            error: String(err),
          })
        }

        // Deliver: merge directly or leave for PR review
        if (route.deliveryMode === "merge") {
          const mergeResult = await this.workspaceManager.mergeAndPush(workspace)
          if (!mergeResult.ok) {
            logger.error("orchestrator", `Merge failed for ${issue.identifier}`, { error: mergeResult.error })
            try {
              await addIssueComment(
                this.config.linearApiKey,
              issue.id,
              `Symphony: Merge failed — manual resolution required\n\n${mergeResult.error}`,
            )
          } catch { /* best-effort */ }
          }

          // Cleanup worktree after merge
          try {
            await this.workspaceManager.cleanup(workspace)
          } catch (cleanupErr) {
            logger.warn("orchestrator", "Worktree cleanup failed", { issueId: issue.id, error: String(cleanupErr) })
          }
        }
        // pr mode: agent already pushed branch + created PR, no merge/cleanup needed

        // Transition to Done
        try {
          await updateIssueState(
            this.config.linearApiKey,
            issue.id,
            this.config.workflowStates.done,
          )
        } catch (err) {
          logger.error("orchestrator", "Failed to transition issue to Done", {
            issueId: issue.id,
            error: String(err),
          })
        }

        this.emitEvent("agent.done", {
          issueKey: issue.identifier,
          issueId: issue.id,
          durationMs: Date.now() - new Date(attempt.startedAt).getTime(),
        })

        logger.info("orchestrator", `Agent completed for ${issue.identifier}`, {
          issueId: issue.id,
          exitCode: completedAttempt.exitCode ?? undefined,
          durationMs: Date.now() - new Date(attempt.startedAt).getTime(),
        })

        // Fill vacant slot from Todo issues
        await this.fillVacantSlots()
      },
      onError: async (err) => {
        const ws = this.state.activeWorkspaces.get(issue.id)
        if (ws) ws.status = "failed"
        this.state.activeWorkspaces.delete(issue.id)
        this.activeAttempts.delete(issue.id)

        this.emitEvent("agent.failed", {
          issueKey: issue.identifier,
          issueId: issue.id,
          error: { code: "AGENT_ERROR", message: err.message, retryable: err.recoverable },
        })
        logger.warn("orchestrator", `Agent failed for ${issue.identifier}`, {
          issueId: issue.id,
          error: err.message,
        })
        if (err.recoverable) {
          const added = this.retryQueue.add(issue.id, 1, err.message)
          if (!added) {
            // Max retries exceeded -- cancel issue with error comment
            try {
              await addIssueComment(
                this.config.linearApiKey,
                issue.id,
                `Symphony: Agent failed (${this.config.agentMaxRetries} retries exceeded)\n\nError: ${err.message}`,
              )
            } catch (commentErr) {
              logger.warn("orchestrator", "Failed to post error comment", {
                issueId: issue.id,
                error: String(commentErr),
              })
            }
            try {
              await updateIssueState(
                this.config.linearApiKey,
                issue.id,
                this.config.workflowStates.cancelled,
              )
            } catch (stateErr) {
              logger.error("orchestrator", "Failed to transition issue to Cancelled", {
                issueId: issue.id,
                error: String(stateErr),
              })
            }
          }
        }

        // Fill vacant slot from Todo issues
        await this.fillVacantSlots()
      },
      onHeartbeat: (timestamp) => {
        // Update last heartbeat for liveness tracking
      },
    })

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
  }

  // ── Retry Queue ───────────────────────────────────────────────────────

  private async processRetryQueue(): Promise<void> {
    const ready = this.retryQueue.drain()
    if (ready.length === 0) return

    // Fetch once to avoid N+1 API calls
    let issues: Issue[] = []
    try {
      issues = await fetchIssuesByState(
        this.config.linearApiKey,
        this.config.linearTeamUuid,
        [this.config.workflowStates.todo, this.config.workflowStates.inProgress],
      )
    } catch (err) {
      logger.warn("orchestrator", "Retry fetch failed, re-queuing entries", { error: String(err) })
      // Re-add entries to queue on fetch failure
      for (const entry of ready) {
        this.retryQueue.add(entry.issueId, entry.attemptCount, entry.lastError)
      }
      return
    }

    for (const entry of ready) {
      const issue = issues.find((i) => i.id === entry.issueId)
      if (issue) {
        if (issue.status.id === this.config.workflowStates.todo) {
          await this.handleIssueTodo(issue)
        } else {
          await this.handleIssueInProgress(issue)
        }
      } else {
        logger.info("orchestrator", "Retry issue no longer in Todo/InProgress, dropping", {
          issueId: entry.issueId,
        })
      }
    }
  }

  // ── Status ────────────────────────────────────────────────────────────

  private getStatus(): Record<string, unknown> {
    const workspaces = Array.from(this.state.activeWorkspaces.entries()).map(([id, ws]) => {
      const attemptId = this.activeAttempts.get(id)
      return {
        issueId: id,
        key: ws.key,
        status: ws.status,
        startedAt: ws.createdAt,
        lastOutput: attemptId ? this.agentRunner.getLastOutput(attemptId) : undefined,
      }
    })

    return {
      isRunning: this.state.isRunning,
      lastEventAt: this.state.lastEventAt,
      activeWorkspaces: workspaces,
      activeAgents: this.agentRunner.activeCount,
      retryQueueSize: this.retryQueue.size,
      config: {
        agentType: this.config.agentType,
        maxParallel: this.config.maxParallel,
        serverPort: this.config.serverPort,
      },
    }
  }
}
