/**
 * FakeRunStatePersistence — in-memory RunStatePort for unit tests.
 * Avoids touching the real filesystem (see persistence/run-state-store.ts).
 */

import type {
  PersistedAttempt,
  PersistedFinalization,
  PersistedRetryEntry,
  RunStatePort,
  RunStateSnapshot,
} from "../../orchestrator/persistence/run-state-store"

export class FakeRunStatePersistence implements RunStatePort {
  /** Calls recorded for assertions. */
  public replaceActiveAttemptsCalls: PersistedAttempt[][] = []
  public replaceRetryQueueCalls: PersistedRetryEntry[][] = []
  public replacePendingFinalizationsCalls: PersistedFinalization[][] = []

  private snapshot: RunStateSnapshot

  constructor(initial: Partial<RunStateSnapshot> = {}) {
    this.snapshot = {
      version: 1,
      updatedAt: "",
      activeAttempts: initial.activeAttempts ?? [],
      retryQueue: initial.retryQueue ?? [],
      pendingFinalizations: initial.pendingFinalizations ?? [],
    }
  }

  async load(): Promise<RunStateSnapshot> {
    return this.snapshot
  }

  replaceActiveAttempts(attempts: PersistedAttempt[]): void {
    this.snapshot = { ...this.snapshot, activeAttempts: attempts }
    this.replaceActiveAttemptsCalls.push(attempts)
  }

  replaceRetryQueue(entries: PersistedRetryEntry[]): void {
    this.snapshot = { ...this.snapshot, retryQueue: entries }
    this.replaceRetryQueueCalls.push(entries)
  }

  replacePendingFinalizations(entries: PersistedFinalization[]): void {
    this.snapshot = { ...this.snapshot, pendingFinalizations: entries }
    this.replacePendingFinalizationsCalls.push(entries)
  }

  async flush(): Promise<void> {
    // In-memory: nothing to flush.
  }

  async flushOrThrow(): Promise<void> {}

  /** Test helper — current in-memory snapshot. */
  current(): RunStateSnapshot {
    return this.snapshot
  }
}
