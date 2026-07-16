/**
 * FakeRunStatePersistence — in-memory RunStatePort for unit tests.
 * Avoids touching the real filesystem (see persistence/run-state-store.ts).
 */

import type {
  PersistedAttempt,
  PersistedRetryEntry,
  RunStatePort,
  RunStateSnapshot,
} from "../../orchestrator/persistence/run-state-store"

export class FakeRunStatePersistence implements RunStatePort {
  /** Calls recorded for assertions. */
  public replaceActiveAttemptsCalls: PersistedAttempt[][] = []
  public replaceRetryQueueCalls: PersistedRetryEntry[][] = []

  private snapshot: RunStateSnapshot

  constructor(initial: Partial<RunStateSnapshot> = {}) {
    this.snapshot = {
      version: 1,
      updatedAt: "",
      activeAttempts: initial.activeAttempts ?? [],
      retryQueue: initial.retryQueue ?? [],
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

  async flush(): Promise<void> {
    // In-memory: nothing to flush.
  }

  /** Test helper — current in-memory snapshot. */
  current(): RunStateSnapshot {
    return this.snapshot
  }
}
