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
import type { ObservabilityHooks } from "../observability/hooks"
import { createNoopObservabilityHooks } from "../observability/hooks"
import { logger } from "../observability/logger"
import { SpawnAgentRunnerAdapter } from "../sessions/adapters/spawn-agent-runner"
import type { AgentRunnerService } from "./agent-runner"
import type { BudgetService } from "./budget-service"
import { createNoopBudgetService } from "./budget-service"
import type { CompletionDeps } from "./completion-handler"
import { DagScheduler } from "./dag-scheduler"
import { buildOrchestratorStatus, sortByIssueNumber } from "./helpers"
import type { InterventionBus } from "./intervention-bus"
import { decideRecovery } from "./persistence/recovery"
import { applyRecoveryDecision, buildPersistedAttempts, cleanupAttemptState } from "./persistence/recovery-apply"
import type { RunStatePort } from "./persistence/run-state-store"
import { RunStatePersistence } from "./persistence/run-state-store"
import { RetryQueue } from "./retry-queue"

/** Reason returned by slot-availability check; callers map to retry / skip. */
export type SlotDecision = { ok: true } | { ok: false; reason: "already_active" | "concurrency" }

/** Narrow callback the core emits upward to the facade, which forwards into OrchestratorEventEmitter.emitEvent. */
export type CoreEventEmit = (event: string, payload: Record<string, unknown>) => void

/** Hook the core calls when state settles and idle slots should be re-filled. Supplied by the facade at wiring time. */
export type FillSlotsHook = () => Promise<void>

/** Supplied by the facade to re-evaluate waiting issues after blocker removal. */
export type ReevaluateWaitingHook = () => Promise<void>

/** Re-entry point used when a retry queue entry or startup-sync issue needs the full Todo / In Progress dispatch path. */
export interface LifecycleDispatcher {
  handleIssueTodo: (issue: Issue, retryContext?: { attemptCount: number; lastError: string }) => Promise<void>
  handleIssueInProgress: (issue: Issue, retryContext?: { attemptCount: number; lastError: string }) => Promise<void>
}

export interface OrchestratorCoreDeps {
  config: Config
  tracker: IssueTracker
  webhook: WebhookReceiver<ParsedWebhookEvent>
  workspace: WorkspaceGateway
  /** AgentRunnerPort adapter. Optional — when omitted, the core creates its own SpawnAgentRunnerAdapter (v0.1 behavior). */
  agentRunner?: SpawnAgentRunnerAdapter
  /** Emit events onto the facade's public event stream. */
  emit: CoreEventEmit
  /** Optional observability hooks (OTel + Prometheus). Omit for no-op behavior; exporter errors never propagate. */
  observability?: ObservabilityHooks
  /** Optional per-issue + per-day budget service. Omit to fall back to a no-op that always allows spawn. Design § 4.5. */
  budget?: BudgetService
  /** Run-state persistence port. Omit to fall back to a real `RunStatePersistence` (`.agent-valley/run-state.json`). */
  runStatePersistence?: RunStatePort
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

  /** Observability hooks — defaults to no-op. Exposed read-only. */
  readonly observability: ObservabilityHooks

  /** Budget service — defaults to no-op. Exposed read-only. */
  readonly budget: BudgetService

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
  /** issueId -> attempt.startedAt, mirrored to disk for crash recovery (see persistence/). */
  private readonly attemptStartedAt = new Map<string, string>()
  /** issueId -> real OS pid of the spawned agent, when known (see registerAttempt). */
  private readonly attemptPid = new Map<string, number>()
  /** Durable mirror of activeAttempts + retryQueue so a crash/restart can recover instead of duplicating runs. */
  private readonly runStatePersistence: RunStatePort
  private recoveryCompleted = false
  private readonly emit: CoreEventEmit
  private retryTimer: ReturnType<typeof setInterval> | null = null
  private promptTemplate = ""
  private startupSyncCompleted = false
  private startupSyncInFlight = false

  /** Wired by the facade before start() so the core can trigger lifecycle flows. */
  private dispatcher: LifecycleDispatcher | null = null
  private reevaluateWaiting: ReevaluateWaitingHook | null = null
  /** Wired by the facade so spawn/cancel flows can keep the bus in sync. */
  private interventionBus: InterventionBus | null = null

  constructor(deps: OrchestratorCoreDeps) {
    this.config = deps.config
    this.tracker = deps.tracker
    this.webhook = deps.webhook
    this.workspace = deps.workspace
    this.emit = deps.emit

    // Port seam: depends on AgentRunnerPort via SpawnAgentRunnerAdapter; builds one wrapping a fresh AgentRunnerService if omitted.
    this.agentRunnerPort = deps.agentRunner ?? new SpawnAgentRunnerAdapter()
    this.agentRunner = this.agentRunnerPort.service
    this.retryQueue = new RetryQueue(this.config.agentMaxRetries, this.config.agentRetryDelay)
    this.dagScheduler = new DagScheduler(`${this.config.workspaceRoot}/.agent-valley/dag-cache.json`)
    this.runStatePersistence =
      deps.runStatePersistence ?? new RunStatePersistence(`${this.config.workspaceRoot}/.agent-valley/run-state.json`)
    this.observability = deps.observability ?? createNoopObservabilityHooks()
    this.budget = deps.budget ?? createNoopBudgetService()
    this.dagScheduler.setCycleObserver(() => this.observability.onDagCycle())
  }

  // ── Facade wiring ──────────────────────────────────────────────────

  attachLifecycle(dispatcher: LifecycleDispatcher, reevaluate: ReevaluateWaitingHook): void {
    this.dispatcher = dispatcher
    this.reevaluateWaiting = reevaluate
  }

  /** Wire the intervention bus so spawn/cancel flows can keep it in sync. */
  attachIntervention(bus: InterventionBus): void {
    this.interventionBus = bus
  }

  /** Read-only accessor for collaborators that need to register attempts. */
  getInterventionBus(): InterventionBus | null {
    return this.interventionBus
  }

  buildCompletionDeps(): CompletionDeps {
    return {
      config: this.config,
      workspace: this.workspace,
      tracker: this.tracker,
      dagScheduler: this.dagScheduler,
      cleanupState: (issueId, status) => {
        cleanupAttemptState(this.recoveryApplyDeps(), issueId, status)
        this.persistActiveAttempts()
      },
      saveAttempt: (ws, att) => this.workspace.saveAttempt(ws, att),
      addRetry: (issueId, count, error, category) => this.retryQueue.add(issueId, count, error, category),
      emitEvent: (event, payload) => this.emit(event, payload),
      fillVacantSlots: () => this.fillVacantSlots(),
      triggerUnblocked: async (issueIds) => {
        for (const id of issueIds) this.state.waitingIssues.delete(id)
        if (this.reevaluateWaiting) await this.reevaluateWaiting()
      },
      observability: this.observability,
      budget: this.budget,
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
      this.observability.onRetryQueueChanged(this.retryQueue.size)
      this.persistRetryQueue()
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
    this.persistActiveAttempts()
  }

  /** Registers the active attempt; called again with `pid` once the session's `spawned` event fires (pid-only update, keeps original `attemptStartedAt`). */
  registerAttempt(issueId: string, attemptId: string, pid?: number): void {
    const isNewAttempt = this.activeAttempts.get(issueId) !== attemptId
    this.activeAttempts.set(issueId, attemptId)
    if (isNewAttempt) this.attemptStartedAt.set(issueId, new Date().toISOString())
    if (pid != null) this.attemptPid.set(issueId, pid)
    this.persistActiveAttempts()
  }

  getAttempt(issueId: string): string | undefined {
    return this.activeAttempts.get(issueId)
  }

  clearAttempt(issueId: string): void {
    this.activeAttempts.delete(issueId)
    this.attemptStartedAt.delete(issueId)
    this.attemptPid.delete(issueId)
    this.persistActiveAttempts()
  }

  enqueueRetry(issueId: string, attemptCount: number, lastError: string): boolean {
    const added = this.retryQueue.add(issueId, attemptCount, lastError)
    this.observability.onRetryQueueChanged(this.retryQueue.size)
    this.persistRetryQueue()
    return added
  }

  removeRetry(issueId: string): void {
    this.retryQueue.remove(issueId)
    this.observability.onRetryQueueChanged(this.retryQueue.size)
    this.persistRetryQueue()
  }

  // ── Crash-recovery persistence — mutation/decision logic lives in persistence/recovery*.ts (500-line cap; sole state authority stays here) ──

  /** Shared dep-bag for persistence/recovery-apply.ts mutators (cleanupAttemptState, applyRecoveryDecision). */
  private recoveryApplyDeps() {
    const { state, activeAttempts, attemptStartedAt, attemptPid, retryQueue, observability, interventionBus } = this
    return { state, activeAttempts, attemptStartedAt, attemptPid, retryQueue, observability, interventionBus }
  }

  /** Mirror `activeAttempts` (+ workspace path) to disk. Fire-and-forget; failures are logged, never thrown. */
  private persistActiveAttempts(): void {
    this.runStatePersistence.replaceActiveAttempts(
      buildPersistedAttempts(this.activeAttempts, this.state.activeWorkspaces, this.attemptStartedAt, this.attemptPid),
    )
  }

  /** Mirror the retry queue to disk. Called after every add/remove/drain. */
  private persistRetryQueue(): void {
    this.runStatePersistence.replaceRetryQueue(this.retryQueue.entries)
  }

  /** Boot recovery — idempotent (guarded by `recoveryCompleted`). Called automatically from `start()`, before startup sync. */
  async recoverFromPersistedState(): Promise<void> {
    if (this.recoveryCompleted) return
    this.recoveryCompleted = true

    const snapshot = await this.runStatePersistence.load()
    if (snapshot.activeAttempts.length === 0 && snapshot.retryQueue.length === 0) return

    const summary = applyRecoveryDecision(decideRecovery(snapshot), this.recoveryApplyDeps())

    this.persistActiveAttempts()
    this.persistRetryQueue()
    logger.info("orchestrator", "Boot recovery complete", {
      reattached: String(summary.reattached),
      reaped: String(summary.reaped),
      restoredRetries: String(summary.restoredRetries),
    })
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
    // Recover before startup sync fetches Todo/InProgress issues, so a still-alive attempt isn't re-dispatched.
    await this.recoverFromPersistedState()

    this.state.isRunning = true
    this.promptTemplate = this.config.promptTemplate

    // Startup sync runs in background so server starts immediately
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
    // Drain persistence write queues so stop() never returns with an in-flight write.
    await Promise.all([this.runStatePersistence.flush(), this.dagScheduler.flush(), this.budget.flush?.() ?? null])

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
    this.persistRetryQueue()
    if (!this.dispatcher) return

    let issues: Issue[] = []
    try {
      issues = await this.tracker.fetchIssuesByState([
        this.config.workflowStates.todo,
        this.config.workflowStates.inProgress,
      ])
    } catch (err) {
      logger.warn("orchestrator", "Retry fetch failed, re-queuing entries", { error: String(err) })
      for (const entry of ready) this.retryQueue.add(entry.issueId, entry.attemptCount, entry.lastError, entry.category)
      this.observability.onRetryQueueChanged(this.retryQueue.size)
      this.persistRetryQueue()
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
