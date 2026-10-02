import type { Config } from "../config/yaml-loader"
import type { Issue, OrchestratorRuntimeState, RetryCategory, Workspace } from "../domain/models"
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
import type { RetryContext } from "./issue-lifecycle"
import { PendingFinalizationManager } from "./pending-finalization"
import { decideRecovery } from "./persistence/recovery"
import {
  applyRecoveryDecision,
  buildPersistedAttempts,
  cleanupAttemptState,
  reconcileRecoveredAttempts,
} from "./persistence/recovery-apply"
import type { PersistedAttempt, RunStatePort } from "./persistence/run-state-store"
import { RunStatePersistence } from "./persistence/run-state-store"
import { CAPACITY_WAIT_REASON, RetryQueue } from "./retry-queue"
import { fillVacantSlots } from "./slot-filler"

export type SlotDecision = { ok: true } | { ok: false; reason: "already_active" | "concurrency" | "stopping" }

export type CoreEventEmit = (event: string, payload: Record<string, unknown>) => void

export type FillSlotsHook = () => Promise<void>

export type ReevaluateWaitingHook = () => Promise<void>

export interface LifecycleDispatcher {
  handleIssueTodo: (issue: Issue, retryContext?: { attemptCount: number; lastError: string }) => Promise<void>
  handleIssueInProgress: (issue: Issue, retryContext?: { attemptCount: number; lastError: string }) => Promise<void>
}

export interface OrchestratorCoreDeps {
  config: Config
  tracker: IssueTracker
  webhook: WebhookReceiver<ParsedWebhookEvent>
  workspace: WorkspaceGateway
  agentRunner?: SpawnAgentRunnerAdapter
  emit: CoreEventEmit
  observability?: ObservabilityHooks
  budget?: BudgetService
  runStatePersistence?: RunStatePort
}

export class OrchestratorCore {
  readonly config: Config
  readonly tracker: IssueTracker
  readonly webhook: WebhookReceiver<ParsedWebhookEvent>
  readonly workspace: WorkspaceGateway

  readonly agentRunner: AgentRunnerService
  readonly agentRunnerPort: SpawnAgentRunnerAdapter
  readonly retryQueue: RetryQueue
  readonly dagScheduler: DagScheduler

  readonly observability: ObservabilityHooks

  readonly budget: BudgetService

  readonly state: OrchestratorRuntimeState = {
    isRunning: false,
    activeWorkspaces: new Map(),
    waitingIssues: new Map(),
    lastEventAt: null,
  }

  readonly processingIssues = new Set<string>()
  isStopping = false
  readonly activeAttempts = new Map<string, string>()
  private readonly attemptStartedAt = new Map<string, string>()
  private readonly attemptPid = new Map<string, number>()
  private readonly runStatePersistence: RunStatePort
  private readonly pendingFinalizations: PendingFinalizationManager
  private recoveryCompleted = false
  private recoveredAttempts: PersistedAttempt[] = []
  private readonly emit: CoreEventEmit
  private retryTimer: ReturnType<typeof setInterval> | null = null
  private promptTemplate = ""
  private startupSyncCompleted = false
  private startupSyncInFlight = false

  private dispatcher: LifecycleDispatcher | null = null
  private reevaluateWaiting: ReevaluateWaitingHook | null = null
  private interventionBus: InterventionBus | null = null

  constructor(deps: OrchestratorCoreDeps) {
    this.config = deps.config
    this.tracker = deps.tracker
    this.webhook = deps.webhook
    this.workspace = deps.workspace
    this.emit = deps.emit

    this.agentRunnerPort = deps.agentRunner ?? new SpawnAgentRunnerAdapter()
    this.agentRunner = this.agentRunnerPort.service
    this.retryQueue = new RetryQueue(this.config.agentMaxRetries, this.config.agentRetryDelay)
    this.dagScheduler = new DagScheduler(`${this.config.workspaceRoot}/.agent-valley/dag-cache.json`)
    this.runStatePersistence =
      deps.runStatePersistence ?? new RunStatePersistence(`${this.config.workspaceRoot}/.agent-valley/run-state.json`)
    this.observability = deps.observability ?? createNoopObservabilityHooks()
    this.budget = deps.budget ?? createNoopBudgetService()
    this.dagScheduler.setCycleObserver(() => this.observability.onDagCycle())
    this.pendingFinalizations = new PendingFinalizationManager({
      config: this.config,
      tracker: this.tracker,
      workspace: this.workspace,
      dag: this.dagScheduler,
      store: this.runStatePersistence,
      emit: this.emit,
      observability: this.observability,
      cleanup: (id, status) => {
        cleanupAttemptState(this.recoveryApplyDeps(), id, status)
        this.persistActiveAttempts()
      },
      triggerUnblocked: async () => {
        if (this.reevaluateWaiting) await this.reevaluateWaiting()
      },
      fillVacantSlots: () => this.fillVacantSlots(),
    })
  }

  attachLifecycle(dispatcher: LifecycleDispatcher, reevaluate: ReevaluateWaitingHook): void {
    this.dispatcher = dispatcher
    this.reevaluateWaiting = reevaluate
  }

  attachIntervention(bus: InterventionBus): void {
    this.interventionBus = bus
  }

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
      addRetry: (issueId, count, error, category) => this.enqueueRetry(issueId, count, error, category),
      emitEvent: (event, payload) => this.emit(event, payload),
      fillVacantSlots: () => this.fillVacantSlots(),
      triggerUnblocked: async () => {
        if (this.reevaluateWaiting) await this.reevaluateWaiting()
      },
      observability: this.observability,
      budget: this.budget,
      finalizeDelivered: (record) => this.pendingFinalizations.add(record),
    }
  }

  emitEvent(event: string, payload: Record<string, unknown>): void {
    this.emit(event, payload)
  }

  canAcceptIssue(issueId: string): SlotDecision {
    if (
      this.processingIssues.has(issueId) ||
      this.state.activeWorkspaces.has(issueId) ||
      this.recoveredAttempts.some((attempt) => attempt.issueId === issueId) ||
      this.pendingFinalizations.has(issueId)
    ) {
      return { ok: false, reason: "already_active" }
    }
    if (this.isStopping) return { ok: false, reason: "stopping" }
    const reserved = new Set([
      ...this.processingIssues,
      ...this.state.activeWorkspaces.keys(),
      ...this.recoveredAttempts.map((attempt) => attempt.issueId),
    ]).size
    if (Math.max(reserved, this.agentRunner.activeCount) >= this.config.maxParallel) {
      return { ok: false, reason: "concurrency" }
    }
    return { ok: true }
  }

  /** Try to accept an issue; queue for retry if at concurrency limit. */
  tryAcceptOrQueue(issueId: string, retryContext?: RetryContext): boolean {
    const guard = this.canAcceptIssue(issueId)
    if (guard.ok) return true
    if (guard.reason === "concurrency") {
      this.retryQueue.add(
        issueId,
        retryContext?.attemptCount ?? 0,
        retryContext?.lastError ?? CAPACITY_WAIT_REASON,
        retryContext?.category,
      )
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

  enqueueRetry(issueId: string, attemptCount: number, lastError: string, category?: RetryCategory): boolean {
    const added = this.retryQueue.add(issueId, attemptCount, lastError, category)
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
    this.pendingFinalizations.restore(snapshot.pendingFinalizations ?? [])
    if (snapshot.activeAttempts.length === 0 && snapshot.retryQueue.length === 0) return

    const recoverable = {
      ...snapshot,
      activeAttempts: snapshot.activeAttempts.filter((entry) => !this.pendingFinalizations.has(entry.issueId)),
      retryQueue: snapshot.retryQueue.filter((entry) => !this.pendingFinalizations.has(entry.issueId)),
    }

    const decision = decideRecovery(recoverable)
    this.recoveredAttempts = decision.reattach
    const summary = applyRecoveryDecision(decision, this.recoveryApplyDeps())

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

  async start(): Promise<void> {
    this.isStopping = false
    // Recover before startup sync fetches Todo/InProgress issues, so a still-alive attempt isn't re-dispatched.
    await this.recoverFromPersistedState()
    void this.pendingFinalizations.reconcile()

    this.state.isRunning = true
    this.promptTemplate = this.config.promptTemplate

    // Startup sync runs in background so server starts immediately
    const runStartupSync = async () => {
      await new Promise((r) => setTimeout(r, 2_000))
      if (this.state.isRunning) await this.ensureStartupSync()
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
    this.isStopping = true
    this.processingIssues.clear()
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
      if (this.retryQueue.entries.some((entry) => entry.issueId === issue.id)) continue
      if (issue.status.id === this.config.workflowStates.todo) await this.dispatcher.handleIssueTodo(issue)
      else await this.dispatcher.handleIssueInProgress(issue)
    }
  }

  async fillVacantSlots(): Promise<void> {
    await fillVacantSlots(this, this.dispatcher)
  }

  async processRetryQueue(): Promise<void> {
    if (this.recoveredAttempts.length > 0) {
      this.recoveredAttempts = reconcileRecoveredAttempts(this.recoveredAttempts, this.recoveryApplyDeps())
      this.persistActiveAttempts()
      this.persistRetryQueue()
    }
    await this.pendingFinalizations.reconcile()
    if (this.reevaluateWaiting && this.state.waitingIssues.size > 0) await this.reevaluateWaiting()
    if (!this.dispatcher) return
    const ready = this.retryQueue.drain()
    if (ready.length === 0) return
    this.persistRetryQueue()

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
      if (this.pendingFinalizations.has(entry.issueId)) continue
      const issue = issues.find((i) => i.id === entry.issueId)
      if (issue) {
        const retryContext = {
          attemptCount: entry.attemptCount,
          lastError: entry.lastError,
          category: entry.category,
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

  async cancelPendingFinalization(issueId: string): Promise<void> {
    await this.pendingFinalizations.cancel(issueId)
  }
}
