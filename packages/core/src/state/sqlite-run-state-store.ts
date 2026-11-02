/**
 * SqliteRunStateStore — RunStatePort over the state database. Active
 * attempts, the retry queue and pending finalizations each live in their
 * own table; every replace is one transaction, so a crash never leaves a
 * half-written list. Writes are serialized and fire-and-forget like the
 * JSON store so OrchestratorCore's call shape is unchanged.
 */

import type { InStatement } from "@libsql/client"
import type { RetryCategory } from "../domain/models"
import { logger } from "../observability/logger"
import {
  type PersistedAttempt,
  type PersistedFinalization,
  type PersistedRetryEntry,
  RunStatePersistence,
  type RunStatePort,
  type RunStateSnapshot,
} from "../orchestrator/persistence/run-state-store"
import { importLegacySnapshot } from "./legacy-json"
import type { StateDatabase } from "./state-database"

const UPDATED_AT = "run_state_updated_at"

export class SqliteRunStateStore implements RunStatePort {
  private snapshot: RunStateSnapshot = { version: 1, updatedAt: "", activeAttempts: [], retryQueue: [] }
  private writeQueue: Promise<void> = Promise.resolve()
  private lastWriteError: unknown = null

  constructor(
    private readonly db: StateDatabase,
    /** `run-state.json` of earlier builds; imported once, then renamed. */
    private readonly legacyPath?: string,
  ) {}

  async load(): Promise<RunStateSnapshot> {
    await importLegacySnapshot(this.db, "run_state", this.legacyPath, async () => {
      if (!this.legacyPath) return
      const legacy = await new RunStatePersistence(this.legacyPath).load()
      await this.db.write([
        ...this.attemptStatements(legacy.activeAttempts),
        ...this.retryStatements(legacy.retryQueue),
        ...this.finalizationStatements(legacy.pendingFinalizations ?? []),
      ])
    })

    const [attempts, retries, finalizations, updatedAt] = await Promise.all([
      this.db.execute({ sql: "SELECT * FROM active_attempts ORDER BY started_at", args: [] }),
      this.db.execute({ sql: "SELECT * FROM retry_queue ORDER BY next_retry_at", args: [] }),
      this.db.execute({ sql: "SELECT record FROM pending_finalizations", args: [] }),
      this.db.getMeta(UPDATED_AT),
    ])
    this.snapshot = {
      version: 1,
      updatedAt: updatedAt ?? "",
      activeAttempts: attempts.rows.map((row) => ({
        issueId: String(row.issue_id),
        attemptId: String(row.attempt_id),
        workspacePath: String(row.workspace_path),
        pid: row.pid == null ? null : Number(row.pid),
        startedAt: String(row.started_at),
      })),
      retryQueue: retries.rows.map((row) => ({
        issueId: String(row.issue_id),
        attemptCount: Number(row.attempt_count),
        nextRetryAt: String(row.next_retry_at),
        lastError: String(row.last_error),
        category: String(row.category) as RetryCategory,
      })),
      pendingFinalizations: finalizations.rows.map((row) => JSON.parse(String(row.record)) as PersistedFinalization),
    }
    logger.info("run-state-persistence", "Loaded run-state from the state database", {
      activeAttempts: String(this.snapshot.activeAttempts.length),
      retryQueue: String(this.snapshot.retryQueue.length),
    })
    return this.snapshot
  }

  replaceActiveAttempts(attempts: PersistedAttempt[]): void {
    this.snapshot.activeAttempts = attempts
    this.persist(this.attemptStatements(attempts))
  }

  replaceRetryQueue(entries: PersistedRetryEntry[]): void {
    this.snapshot.retryQueue = entries
    this.persist(this.retryStatements(entries))
  }

  replacePendingFinalizations(entries: PersistedFinalization[]): void {
    this.snapshot.pendingFinalizations = entries
    this.persist(this.finalizationStatements(entries))
  }

  async flush(): Promise<void> {
    await this.writeQueue
  }

  async flushOrThrow(): Promise<void> {
    await this.writeQueue
    if (this.lastWriteError) throw this.lastWriteError
  }

  private attemptStatements(attempts: PersistedAttempt[]): InStatement[] {
    return [
      { sql: "DELETE FROM active_attempts", args: [] },
      ...attempts.map((attempt) => ({
        sql: "INSERT INTO active_attempts (issue_id, attempt_id, workspace_path, pid, started_at) VALUES (?, ?, ?, ?, ?)",
        args: [attempt.issueId, attempt.attemptId, attempt.workspacePath, attempt.pid, attempt.startedAt],
      })),
    ]
  }

  private retryStatements(entries: PersistedRetryEntry[]): InStatement[] {
    return [
      { sql: "DELETE FROM retry_queue", args: [] },
      ...entries.map((entry) => ({
        sql: "INSERT INTO retry_queue (issue_id, attempt_count, next_retry_at, last_error, category) VALUES (?, ?, ?, ?, ?)",
        args: [entry.issueId, entry.attemptCount, entry.nextRetryAt, entry.lastError, entry.category ?? "infra"],
      })),
    ]
  }

  private finalizationStatements(entries: PersistedFinalization[]): InStatement[] {
    return [
      { sql: "DELETE FROM pending_finalizations", args: [] },
      ...entries.map((entry) => ({
        sql: "INSERT INTO pending_finalizations (issue_id, record) VALUES (?, ?)",
        args: [entry.issueId, JSON.stringify(entry)],
      })),
    ]
  }

  /** Serialized, fire-and-forget transaction; failures are logged and surfaced by flushOrThrow. */
  private persist(statements: InStatement[]): void {
    const updatedAt = new Date().toISOString()
    this.writeQueue = this.writeQueue
      .then(async () => {
        await this.db.write([...statements, this.db.setMetaStatement(UPDATED_AT, updatedAt)])
        this.snapshot.updatedAt = updatedAt
        this.lastWriteError = null
      })
      .catch((err) => {
        this.lastWriteError = err
        logger.error("run-state-persistence", "Failed to save run-state to the state database", {
          error: String(err),
        })
      })
  }
}
