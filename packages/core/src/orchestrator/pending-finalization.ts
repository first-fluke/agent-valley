import type { Config } from "../config/yaml-loader"
import type { IssueTracker } from "../domain/ports/tracker"
import type { WorkspaceGateway } from "../domain/ports/workspace"
import type { ObservabilityHooks } from "../observability/hooks"
import { logger } from "../observability/logger"
import type { DagScheduler } from "./dag-scheduler"
import { buildParentSummary } from "./helpers"
import type { PersistedFinalization, RunStatePort } from "./persistence/run-state-store"

export class PendingFinalizationManager {
  private readonly pending = new Map<string, PersistedFinalization>()
  private readonly inFlight = new Set<string>()
  private readonly undurable = new Set<string>()
  private readonly emittedAttempts = new Set<string>()

  constructor(
    private readonly deps: {
      config: Config
      tracker: IssueTracker
      workspace: WorkspaceGateway
      dag: DagScheduler
      store: RunStatePort
      emit: (event: string, payload: Record<string, unknown>) => void
      observability: ObservabilityHooks
      cleanup: (issueId: string, status: "done" | "failed") => void
      triggerUnblocked: (issueIds: string[]) => Promise<void>
      fillVacantSlots: () => Promise<void>
    },
  ) {}

  has(issueId: string): boolean {
    return this.pending.has(issueId)
  }
  restore(records: PersistedFinalization[]): void {
    for (const record of records) this.pending.set(record.issueId, record)
  }

  async add(record: PersistedFinalization): Promise<void> {
    this.pending.set(record.issueId, record)
    this.undurable.add(record.issueId)
    this.persist()
    await this.deps.store.flushOrThrow()
    this.undurable.delete(record.issueId)
    // The delivery is durable now. Retire the active attempt and release its slot.
    this.deps.cleanup(record.issueId, "failed")
    await this.deps.fillVacantSlots()
    await this.reconcileOne(record.issueId)
  }

  async cancel(issueId: string): Promise<void> {
    const record = this.pending.get(issueId)
    if (!record) return
    this.pending.delete(issueId)
    this.persist()
    try {
      await this.deps.store.flushOrThrow()
    } catch (err) {
      this.pending.set(issueId, record)
      throw err
    }
    this.undurable.delete(issueId)
    this.deps.dag.updateNodeStatus(issueId, "cancelled")
  }

  async reconcile(): Promise<void> {
    if (this.undurable.size > 0) {
      this.persist()
      try {
        await this.deps.store.flushOrThrow()
        for (const id of this.undurable) this.deps.cleanup(id, "failed")
        this.undurable.clear()
        await this.deps.fillVacantSlots()
      } catch {
        return
      }
    }
    for (const issueId of [...this.pending.keys()]) await this.reconcileOne(issueId)
  }

  private persist(): void {
    this.deps.store.replacePendingFinalizations([...this.pending.values()])
  }

  private async reconcileOne(issueId: string): Promise<void> {
    const record = this.pending.get(issueId)
    if (!record || this.inFlight.has(issueId) || this.undurable.has(issueId)) return
    const isCurrent = () => this.pending.get(issueId) === record
    this.inFlight.add(issueId)
    try {
      // A user cancellation wins over a delayed Done retry, including after restart.
      const cancelled = await this.deps.tracker.fetchIssuesByState([this.deps.config.workflowStates.cancelled])
      if (!isCurrent()) return
      if (cancelled.some((issue) => issue.id === issueId)) {
        await this.cancel(issueId)
        return
      }
      if (record.phase !== "tracker_confirmed") {
        let updated = false
        for (let attempt = 0; attempt < 3 && !updated; attempt++) {
          if (!isCurrent()) return
          try {
            await this.deps.tracker.updateIssueState(issueId, this.deps.config.workflowStates.done)
            updated = true
          } catch (err) {
            logger.warn("completion", "Tracker Done finalization pending", { issueId, error: String(err) })
          }
        }
        if (!updated || !isCurrent()) return
        record.phase = "tracker_confirmed"
        this.persist()
        await this.deps.store.flushOrThrow()
        if (!isCurrent()) return
      }
      if (record.deliveryMode === "merge" && record.hasCodeChanges) {
        try {
          await this.deps.workspace.cleanup(record.workspace)
        } catch (err) {
          logger.warn("completion", "Worktree cleanup failed", { issueId, error: String(err) })
        }
      }
      if (!isCurrent()) return
      if (!this.emittedAttempts.has(record.attemptId)) {
        this.deps.emit("agent.done", {
          issueKey: record.issueKey,
          issueId,
          attemptId: record.attemptId,
          durationMs: record.durationMs,
          autoCommitted: record.autoCommitted,
        })
        this.emittedAttempts.add(record.attemptId)
        this.deps.observability.onAgentDone({
          agentType: record.agentType,
          issueKey: record.issueKey,
          issueId,
          attemptId: record.attemptId,
          durationMs: record.durationMs,
          tokenUsage: record.tokenUsage,
        })
      }
      this.deps.dag.updateNodeStatus(issueId, "done")
      const unblocked = this.deps.dag.getUnblockedByCompletion(issueId)
      if (unblocked.length > 0) await this.deps.triggerUnblocked(unblocked)
      if (!isCurrent()) return
      if (record.parentId && this.deps.dag.allChildrenDone(record.parentId)) {
        try {
          const children = this.deps.dag.getChildrenSummaries(record.parentId)
          await this.deps.tracker.addIssueComment(record.parentId, buildParentSummary(children))
          if (!isCurrent()) return
          await this.deps.tracker.updateIssueState(record.parentId, this.deps.config.workflowStates.done)
          if (!isCurrent()) return
        } catch (err) {
          logger.warn("completion", "Failed to auto-complete parent", { parentId: record.parentId, error: String(err) })
        }
      }
      if (!isCurrent()) return
      // Keep the in-memory guard until the cleared snapshot is durable. This
      // also leaves the original record available for retry if the write fails.
      this.deps.store.replacePendingFinalizations([...this.pending.values()].filter((entry) => entry !== record))
      try {
        await this.deps.store.flushOrThrow()
      } catch (err) {
        if (isCurrent()) this.persist()
        throw err
      }
      if (!isCurrent()) return
      this.pending.delete(issueId)
      await this.deps.fillVacantSlots()
    } catch (err) {
      logger.warn("completion", "Pending tracker finalization deferred", { issueId, error: String(err) })
    } finally {
      this.inFlight.delete(issueId)
    }
  }
}
