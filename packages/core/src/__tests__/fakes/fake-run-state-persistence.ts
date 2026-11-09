/**
 * FakeRunStatePersistence — in-memory RunStatePort for unit tests.
 * Avoids touching the real filesystem (see persistence/run-state-store.ts).
 */

import type { DeadLetterEntry } from "../../domain/models"
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
  public replaceDeadLetterQueueCalls: DeadLetterEntry[][] = []
  public replacePendingFinalizationsCalls: PersistedFinalization[][] = []

  private snapshot: RunStateSnapshot

  constructor(initial: Partial<RunStateSnapshot> = {}) {
    this.snapshot = {
      version: 1,
      updatedAt: "",
      activeAttempts: initial.activeAttempts ?? [],
      retryQueue: initial.retryQueue ?? [],
      deadLetterQueue: initial.deadLetterQueue ?? [],
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

  replaceRetryQueue(entries: PersistedRetryEntry[], deadLetter?: DeadLetterEntry[]): void {
    this.snapshot = {
      ...this.snapshot,
      retryQueue: entries,
      ...(deadLetter !== undefined ? { deadLetterQueue: deadLetter } : {}),
    }
    this.replaceRetryQueueCalls.push(entries)
    if (deadLetter !== undefined) {
      this.replaceDeadLetterQueueCalls.push(deadLetter)
    }
  }

  replaceDeadLetterQueue(entries: DeadLetterEntry[]): void {
    this.snapshot = { ...this.snapshot, deadLetterQueue: entries }
    this.replaceDeadLetterQueueCalls.push(entries)
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
