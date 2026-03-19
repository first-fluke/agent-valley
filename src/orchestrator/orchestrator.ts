/**
 * Orchestrator — Core Symphony component.
 * Webhook-driven event handler, state machine, retry queue.
 * Sole authority over in-memory runtime state.
 */

import type { Config } from "../config/config"
import type { Issue, Workspace, RunAttempt, OrchestratorRuntimeState } from "../domain/models"
import type { WebhookEvent } from "../tracker/types"
import { fetchIssuesByState, updateIssueState, addIssueComment } from "../tracker/linear-client"
import { verifyWebhookSignature, parseWebhookEvent } from "../tracker/webhook-handler"
import { WorkspaceManager } from "../workspace/workspace-manager"
import { AgentRunnerService } from "./agent-runner"
import { RetryQueue } from "./retry-queue"
import { startHttpServer } from "../server/http-server"
import { parseWorkflow, renderPrompt } from "../config/workflow-loader"
import { logger } from "../observability/logger"

export class Orchestrator {
  private state: OrchestratorRuntimeState = {
    isRunning: false,
    activeWorkspaces: new Map(),
    retryQueue: [],
    lastEventAt: null,
  }

  private workspaceManager: WorkspaceManager
  private agentRunner: AgentRunnerService
  private retryQueue: RetryQueue
  private httpServer: { stop: () => void } | null = null
  private retryTimer: ReturnType<typeof setInterval> | null = null
  private promptTemplate: string = ""

  constructor(private config: Config) {
    this.workspaceManager = new WorkspaceManager(config.workspaceRoot)
    this.agentRunner = new AgentRunnerService()
    this.retryQueue = new RetryQueue(config.agentMaxRetries, config.agentRetryDelay)
  }

  async start(): Promise<void> {
    this.state.isRunning = true

    // Load WORKFLOW.md prompt template
    const workflowContent = await Bun.file("WORKFLOW.md").text()
    const { promptTemplate } = parseWorkflow(workflowContent)
    this.promptTemplate = promptTemplate

    // Startup sync — one-time Linear API call
    await this.startupSync()

    // Start HTTP server
    this.httpServer = startHttpServer(this.config.serverPort, {
      onWebhook: (payload, signature) => this.handleWebhook(payload, signature),
      getStatus: () => this.getStatus(),
    })

    // Periodic retry queue processing
    this.retryTimer = setInterval(() => this.processRetryQueue(), 30_000)

    logger.info("orchestrator", "Symphony started", {
      agentType: this.config.agentType,
      maxParallel: String(this.config.maxParallel),
    })
  }

  async stop(): Promise<void> {
    logger.info("orchestrator", "Shutting down gracefully...")
    this.state.isRunning = false

    if (this.retryTimer) clearInterval(this.retryTimer)
    this.httpServer?.stop()

    // Wait for active agents to complete
    await this.agentRunner.killAll()

    logger.info("orchestrator", "Shutdown complete")
  }

  // ── Startup Sync ──────────────────────────────────────────────────────

  private async startupSync(): Promise<void> {
    try {
      const issues = await fetchIssuesByState(
        this.config.linearApiKey,
        this.config.linearTeamUuid,
        [this.config.workflowStates.todo, this.config.workflowStates.inProgress],
      )

      logger.info("orchestrator", `Startup sync completed, found ${issues.length} issues`)

      for (const issue of issues) {
        if (issue.status.id === this.config.workflowStates.todo) {
          await this.handleIssueTodo(issue)
        } else {
          await this.handleIssueInProgress(issue)
        }
      }
    } catch (err) {
      logger.error("orchestrator", "Startup sync failed", { error: String(err) })
      // Continue running — webhooks will still work
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

  // ── Issue Handling ────────────────────────────────────────────────────

  private async handleIssueTodo(issue: Issue): Promise<void> {
    // Duplicate check
    if (this.state.activeWorkspaces.has(issue.id)) {
      logger.debug("orchestrator", "Issue already active, skipping Todo", { issueId: issue.id })
      return
    }

    // Concurrency check — keep in Todo if at capacity
    if (this.agentRunner.activeCount >= this.config.maxParallel) {
      logger.warn("orchestrator", "Concurrency limit reached, keeping in Todo", {
        issueId: issue.id,
        activeCount: String(this.agentRunner.activeCount),
        maxParallel: String(this.config.maxParallel),
      })
      this.retryQueue.add(issue.id, 0, "Concurrency limit reached")
      return
    }

    // Transition Todo → In Progress on Linear
    try {
      await updateIssueState(
        this.config.linearApiKey,
        issue.id,
        this.config.workflowStates.inProgress,
      )
      logger.info("orchestrator", `Transitioned ${issue.identifier} from Todo to In Progress`)
    } catch (err) {
      logger.error("orchestrator", "Failed to transition issue to In Progress", {
        issueId: issue.id,
        error: String(err),
      })
      this.retryQueue.add(issue.id, 0, `State transition failed: ${err}`)
      return
    }

    // Update local issue status and delegate to In Progress handler
    issue.status = { ...issue.status, id: this.config.workflowStates.inProgress, name: "In Progress" }
    await this.handleIssueInProgress(issue)
  }

  private async handleIssueInProgress(issue: Issue): Promise<void> {
    // Duplicate check
    if (this.state.activeWorkspaces.has(issue.id)) {
      logger.debug("orchestrator", "Issue already active, skipping", { issueId: issue.id })
      return
    }

    // Concurrency check
    if (this.agentRunner.activeCount >= this.config.maxParallel) {
      logger.warn("orchestrator", "Concurrency limit reached, queuing", {
        issueId: issue.id,
        activeCount: String(this.agentRunner.activeCount),
        maxParallel: String(this.config.maxParallel),
      })
      // Add to retry queue for later processing
      this.retryQueue.add(issue.id, 0, "Concurrency limit reached")
      return
    }

    // Create workspace
    let workspace: Workspace
    try {
      workspace = await this.workspaceManager.create(issue)
    } catch (err) {
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

    // Render prompt
    const prompt = renderPrompt(this.promptTemplate, issue, workspace.path, attempt, 0)

    // Spawn agent
    await this.agentRunner.spawn(attempt, {
      agentType: this.config.agentType,
      timeout: this.config.agentTimeout,
      prompt,
      workspacePath: workspace.path,
    }, {
      onComplete: async (completedAttempt) => {
        const ws = this.state.activeWorkspaces.get(issue.id)
        if (ws) ws.status = "done"
        this.state.activeWorkspaces.delete(issue.id)
        this.workspaceManager.saveAttempt(workspace, completedAttempt)

        // Post work summary comment (best-effort — don't block Done transition)
        try {
          const summary = this.buildWorkSummary(completedAttempt)
          await addIssueComment(this.config.linearApiKey, issue.id, summary)
        } catch (err) {
          logger.warn("orchestrator", "Failed to post work summary comment", {
            issueId: issue.id,
            error: String(err),
          })
        }

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

        logger.info("orchestrator", `Agent completed for ${issue.identifier}`, {
          issueId: issue.id,
          exitCode: completedAttempt.exitCode ?? undefined,
          durationMs: Date.now() - new Date(attempt.startedAt).getTime(),
        })
      },
      onError: async (err) => {
        const ws = this.state.activeWorkspaces.get(issue.id)
        if (ws) ws.status = "failed"
        this.state.activeWorkspaces.delete(issue.id)
        logger.warn("orchestrator", `Agent failed for ${issue.identifier}`, {
          issueId: issue.id,
          error: err.message,
        })
        if (err.recoverable) {
          const added = this.retryQueue.add(issue.id, 1, err.message)
          if (!added) {
            // Max retries exceeded — cancel issue with error comment
            try {
              await addIssueComment(
                this.config.linearApiKey,
                issue.id,
                `⚠️ Symphony: Agent failed (${this.config.agentMaxRetries} retries exceeded)\n\nError: ${err.message}`,
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

    // Find and kill the active session
    // The agent runner will handle cleanup via the error callback
    this.state.activeWorkspaces.delete(issueId)
    this.retryQueue.remove(issueId)
  }

  // ── Retry Queue ───────────────────────────────────────────────────────

  private async processRetryQueue(): Promise<void> {
    const ready = this.retryQueue.drain()
    for (const entry of ready) {
      try {
        const issues = await fetchIssuesByState(
          this.config.linearApiKey,
          this.config.linearTeamUuid,
          [this.config.workflowStates.todo, this.config.workflowStates.inProgress],
        )
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
      } catch (err) {
        logger.warn("orchestrator", "Retry re-fetch failed", {
          issueId: entry.issueId,
          error: String(err),
        })
      }
    }
  }

  // ── Work Summary ──────────────────────────────────────────────────────

  private buildWorkSummary(attempt: RunAttempt): string {
    const output = attempt.agentOutput ?? "No output captured"
    const duration = attempt.finishedAt && attempt.startedAt
      ? Math.round((new Date(attempt.finishedAt).getTime() - new Date(attempt.startedAt).getTime()) / 1000)
      : 0

    return [
      `✅ Symphony: Work completed`,
      ``,
      `**Duration:** ${duration}s`,
      `**Exit code:** ${attempt.exitCode}`,
      ``,
      `### Agent Output`,
      output.length > 4000 ? output.slice(0, 4000) + "\n...(truncated)" : output,
    ].join("\n")
  }

  // ── Status ────────────────────────────────────────────────────────────

  private getStatus(): Record<string, unknown> {
    const workspaces = Array.from(this.state.activeWorkspaces.entries()).map(([id, ws]) => ({
      issueId: id,
      key: ws.key,
      status: ws.status,
      startedAt: ws.createdAt,
    }))

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
