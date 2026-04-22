/**
 * OrchestratorCore — Owns OrchestratorRuntimeState and the supporting
 * sub-services (retry queue, DAG scheduler, agent runner). This is the
 * single authority for in-memory state mutations. Webhook routing and
 * issue lifecycle handlers access state only through the narrow API
 * exposed here.
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 3.1 / § 5.3 (PR3).
 */

import type { Config } from "../config/yaml-loader"
import type { Issue, OrchestratorRuntimeState, Workspace } from "../domain/models"
import type { ParsedWebhookEvent } from "../domain/parsed-webhook-event"
import type { IssueTracker, WebhookReceiver } from "../domain/ports/tracker"
import type { WorkspaceGateway } from "../domain/ports/workspace"
import { logger } from "../observability/logger"
import { SpawnAgentRunnerAdapter } from "../sessions/adapters/spawn-agent-runner"
import type { AgentRunnerService } from "./agent-runner"
import type { CompletionDeps } from "./completion-handler"
import { DagScheduler } from "./dag-scheduler"
import { buildOrchestratorStatus, sortByIssueNumber } from "./helpers"
import { RetryQueue } from "./retry-queue"

/** Reason returned by slot-availability check; callers map to retry / skip. */
export type SlotDecision = { ok: true } | { ok: false; reason: "already_active" | "concurrency" }

/**
 * Narrow callbacks the core emits upward to the facade; the facade
 * forwards into OrchestratorEventEmitter.emitEvent. Defined as a type
 * to keep core free of any upward import.
 */
export type CoreEventEmit = (event: string, payload: Record<string, unknown>) => void

/**
 * Hook the core calls when state settles and idle slots should be
 * re-filled. Supplied by the facade at wiring time so the core does
 * not need to know about IssueLifecycle.
 */
export type FillSlotsHook = () => Promise<void>

/** Supplied by the facade to re-evaluate waiting issues after blocker removal. */
export type ReevaluateWaitingHook = () => Promise<void>

/**
 * Re-entry point used when a retry queue entry or startup-sync issue
 * needs to drive the full Todo / In Progress dispatch path.
 */
export interface LifecycleDispatcher {
  handleIssueTodo: (issue: Issue, retryContext?: { attemptCount: number; lastError: string }) => Promise<void>
  handleIssueInProgress: (issue: Issue, retryContext?: { attemptCount: number; lastError: string }) => Promise<void>
}

export interface OrchestratorCoreDeps {
  config: Config
  tracker: IssueTracker
  webhook: WebhookReceiver<ParsedWebhookEvent>
  workspace: WorkspaceGateway
  /**
   * AgentRunnerPort adapter. Optional — when omitted, the core creates
   * its own SpawnAgentRunnerAdapter (preserving v0.1 behavior).
   */
  agentRunner?: SpawnAgentRunnerAdapter
  /** Emit events onto the facade's public event stream. */
  emit: CoreEventEmit
}

export class OrchestratorCore {
  readonly config: Config
  readonly tracker: IssueTracker
  readonly webhook: WebhookReceiver<ParsedWebhookEvent>
  readonly workspace: WorkspaceGateway

  readonly agentRunner: AgentRunnerService
  /** Port-shaped view of the runner (spawn RunHandle + capabilities()). */
  readonly agentRunnerPort: SpawnAgentRunnerAdapter
  readonly retryQueue: RetryQueue
  readonly dagScheduler: DagScheduler

  readonly state: OrchestratorRuntimeState = {
    isRunning: false,
    activeWorkspaces: new Map(),
    waitingIssues: new Map(),
    lastEventAt: null,
  }

  /** Guards against TOCTOU race: tracks issues currently being processed. */
  readonly processingIssues = new Set<string>()

  /** Maps issueId -> attemptId for active agent sessions. */
  readonly activeAttempts = new Map<string, string>()

  private readonly emit: CoreEventEmit
  private retryTimer: ReturnType<typeof setInterval> | null = null
  private promptTemplate = ""
  private startupSyncCompleted = false
  private startupSyncInFlight = false

  /** Wired by the facade before start() so the core can trigger lifecycle flows. */
  private dispatcher: LifecycleDispatcher | null = null
  private reevaluateWaiting: ReevaluateWaitingHook | null = null

  constructor(deps: OrchestratorCoreDeps) {
    this.config = deps.config
    this.tracker = deps.tracker
    this.webhook = deps.webhook
    this.workspace = deps.workspace
    this.emit = deps.emit

    // Port seam: orchestrator-core depends on AgentRunnerPort via the
    // SpawnAgentRunnerAdapter. When no adapter is injected, build a
    // fresh one wrapping a new AgentRunnerService (v0.1 behavior).
    this.agentRunnerPort = deps.agentRunner ?? new SpawnAgentRunnerAdapter()
    this.agentRunner = this.agentRunnerPort.service
    this.retryQueue = new RetryQueue(this.config.agentMaxRetries, this.config.agentRetryDelay)
    this.dagScheduler = new DagScheduler(`${this.config.workspaceRoot}/.agent-valley/dag-cache.json`)
  }

  // ── Facade wiring ──────────────────────────────────────────────────

  attachLifecycle(dispatcher: LifecycleDispatcher, reevaluate: ReevaluateWaitingHook): void {
    this.dispatcher = dispatcher
    this.reevaluateWaiting = reevaluate
  }

  buildCompletionDeps(): CompletionDeps {
    return {
      config: this.config,
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
      emitEvent: (event, payload) => this.emit(event, payload),
      fillVacantSlots: () => this.fillVacantSlots(),
      triggerUnblocked: async (issueIds) => {
        for (const id of issueIds) {
          this.state.waitingIssues.delete(id)
        }
        if (this.reevaluateWaiting) await this.reevaluateWaiting()
      },
    }
  }

  // ── Public event emit (used by issue-lifecycle and router) ────────

  emitEvent(event: string, payload: Record<string, unknown>): void {
    this.emit(event, payload)
  }

  // ── Runtime state API (narrow, callable by lifecycle/router) ──────

  canAcceptIssue(issueId: string): SlotDecision {
    if (this.processingIssues.has(issueId) || this.state.activeWorkspaces.has(issueId)) {
      return { ok: false, reason: "already_active" }
    }
    if (this.agentRunner.activeCount >= this.config.maxParallel) {
      return { ok: false, reason: "concurrency" }
    }
    return { ok: true }
  }

  /** Try to accept an issue; queue for retry if at concurrency limit. */
  tryAcceptOrQueue(issueId: string): boolean {
    const guard = this.canAcceptIssue(issueId)
    if (guard.ok) return true
    if (guard.reason === "concurrency") {
      this.retryQueue.add(issueId, 0, "Concurrency limit reached")
    }
    return false
  }

  markProcessing(issueId: string): void {
    this.processingIssues.add(issueId)
  }

  releaseProcessing(issueId: string): void {
    this.processingIssues.delete(issueId)
  }

  addActiveWorkspace(issueId: string, workspace: Workspace): void {
    this.state.activeWorkspaces.set(issueId, workspace)
  }

  getActiveWorkspace(issueId: string): Workspace | undefined {
    return this.state.activeWorkspaces.get(issueId)
  }

  removeActiveWorkspace(issueId: string): void {
    this.state.activeWorkspaces.delete(issueId)
  }

  registerAttempt(issueId: string, attemptId: string): void {
    this.activeAttempts.set(issueId, attemptId)
  }

  getAttempt(issueId: string): string | undefined {
    return this.activeAttempts.get(issueId)
  }

  clearAttempt(issueId: string): void {
    this.activeAttempts.delete(issueId)
  }

  enqueueRetry(issueId: string, attemptCount: number, lastError: string): boolean {
    return this.retryQueue.add(issueId, attemptCount, lastError)
  }

  removeRetry(issueId: string): void {
    this.retryQueue.remove(issueId)
  }

  addWaitingIssue(
    issueId: string,
    entry: { issueId: string; identifier: string; blockedBy: string[]; enqueuedAt: string },
  ): void {
    this.state.waitingIssues.set(issueId, entry)
  }

  hasWaitingIssue(issueId: string): boolean {
    return this.state.waitingIssues.has(issueId)
  }

  deleteWaitingIssue(issueId: string): void {
    this.state.waitingIssues.delete(issueId)
  }

  waitingIssueIds(): string[] {
    return [...this.state.waitingIssues.keys()]
  }

  getWaitingEntry(issueId: string): { identifier: string } | undefined {
    return this.state.waitingIssues.get(issueId)
  }

  touchLastEvent(): void {
    this.state.lastEventAt = new Date().toISOString()
  }

  getPromptTemplate(): string {
    return this.promptTemplate
  }

  // ── Lifecycle (start / stop / startup sync / retry timer) ─────────

  async start(): Promise<void> {
    this.state.isRunning = true
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

    this.emit("node.join", {
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
    this.emit("node.leave", { reason: "graceful" })
    this.state.isRunning = false

    if (this.retryTimer) clearInterval(this.retryTimer)

    await this.agentRunner.killAll()

    logger.info("orchestrator", "Shutdown complete")
  }

  async ensureStartupSync(): Promise<void> {
    if (this.startupSyncCompleted || this.startupSyncInFlight) return

    this.startupSyncInFlight = true
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await this.runStartupSync()
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

  private async runStartupSync(): Promise<void> {
    if (!this.dispatcher) {
      throw new Error(
        "OrchestratorCore.runStartupSync: dispatcher is not attached.\n" +
          "  Fix: call attachLifecycle({handleIssueTodo, handleIssueInProgress}, reevaluate) before start().\n" +
          "  Location: orchestrator facade constructor.",
      )
    }
    const issues = await this.tracker.fetchIssuesByState([
      this.config.workflowStates.todo,
      this.config.workflowStates.inProgress,
    ])
    await this.dagScheduler.reconcileWithLinear(issues)
    sortByIssueNumber(issues)
    logger.info("orchestrator", `Startup sync completed, found ${issues.length} issues`)
    for (const issue of issues) {
      if (issue.status.id === this.config.workflowStates.todo) await this.dispatcher.handleIssueTodo(issue)
      else await this.dispatcher.handleIssueInProgress(issue)
    }
  }

  async fillVacantSlots(): Promise<void> {
    const available = this.config.maxParallel - this.agentRunner.activeCount
    if (available <= 0) return
    if (!this.dispatcher) return

    try {
      const issues = await this.tracker.fetchIssuesByState([this.config.workflowStates.todo])

      sortByIssueNumber(issues)

      let filled = 0
      for (const issue of issues) {
        if (filled >= available) break
        const guard = this.canAcceptIssue(issue.id)
        if (!guard.ok) continue
        await this.dispatcher.handleIssueTodo(issue)
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

  async processRetryQueue(): Promise<void> {
    const ready = this.retryQueue.drain()
    if (ready.length === 0) return
    if (!this.dispatcher) return

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
        if (issue.status.id === this.config.workflowStates.todo)
          await this.dispatcher.handleIssueTodo(issue, retryContext)
        else await this.dispatcher.handleIssueInProgress(issue, retryContext)
      } else {
        logger.info("orchestrator", "Retry issue no longer in Todo/InProgress, dropping", { issueId: entry.issueId })
      }
    }
  }

  getStatus(): Record<string, unknown> {
    return buildOrchestratorStatus(this.state, this.activeAttempts, this.agentRunner, this.retryQueue, this.config)
  }
}
