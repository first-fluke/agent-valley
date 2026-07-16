/**
 * RunStatePersistence — Durable snapshot of in-flight orchestrator run
 * state (active attempts + retry queue) so a process crash/restart can
 * be recovered without silently duplicating agent runs.
 *
 * Mirrors DagScheduler's JSON-cache persistence pattern (see
 * `../dag-scheduler.ts`): same `.agent-valley/` directory, same
 * "serialized write queue" fire-and-forget persist, same
 * load-or-default-on-missing-or-corrupt behavior.
 *
 * OrchestratorCore remains the sole authority over in-memory runtime
 * state — this class only mirrors that state to disk on request. It
 * never mutates OrchestratorCore's Maps itself.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { RetryCategory } from "../../domain/models"
import { logger } from "../../observability/logger"

/**
 * A single in-flight (or just-crashed) agent run, as last known before
 * persisting. `pid` is the OS process id of the spawned agent, used by
 * boot recovery to probe liveness with `process.kill(pid, 0)`.
 *
 * LIMITATION: `AgentRunnerService` / `AgentSession` (packages/core/src/
 * orchestrator/agent-runner.ts, packages/core/src/sessions/*) do not
 * currently surface the child process PID past their own module
 * boundary — `RunOptions` / `RunCallbacks` / `AgentEvent` carry no pid
 * field. Threading a real PID up to OrchestratorCore requires editing
 * those files, which is out of scope for this change (see result doc
 * follow-ups). Until then, `pid` is always persisted as `null` and
 * `decideRecovery()` conservatively treats a `null` pid as "cannot
 * verify liveness" — see `./recovery.ts`.
 */
export interface PersistedAttempt {
  issueId: string
  attemptId: string
  workspacePath: string
  /** OS process id of the spawned agent, when known. Always `null` today — see LIMITATION above. */
  pid: number | null
  startedAt: string
}

export interface PersistedRetryEntry {
  issueId: string
  attemptCount: number
  nextRetryAt: string
  lastError: string
  /**
   * Failure classification (see `RetryCategory` in domain/models.ts).
   * Optional on read: snapshots written before this field existed have no
   * `category` key — `load()` defaults those entries to "infra" (the prior
   * behavior) so an old snapshot on disk survives an upgrade without a
   * migration step.
   */
  category?: RetryCategory
}

export interface RunStateSnapshot {
  version: 1
  updatedAt: string
  activeAttempts: PersistedAttempt[]
  retryQueue: PersistedRetryEntry[]
}

function emptySnapshot(): RunStateSnapshot {
  return { version: 1, updatedAt: "", activeAttempts: [], retryQueue: [] }
}

/**
 * Narrow port OrchestratorCore depends on, so tests can inject an
 * in-memory fake instead of touching the real filesystem.
 */
export interface RunStatePort {
  load(): Promise<RunStateSnapshot>
  replaceActiveAttempts(attempts: PersistedAttempt[]): void
  replaceRetryQueue(entries: PersistedRetryEntry[]): void
  /** Await any in-flight writes. Test-only convenience. */
  flush(): Promise<void>
}

export class RunStatePersistence implements RunStatePort {
  private snapshot: RunStateSnapshot = emptySnapshot()
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly storePath: string) {}

  async load(): Promise<RunStateSnapshot> {
    try {
      const raw = await readFile(this.storePath, "utf-8")
      const parsed = JSON.parse(raw) as RunStateSnapshot
      this.snapshot = {
        version: 1,
        updatedAt: parsed.updatedAt ?? "",
        activeAttempts: Array.isArray(parsed.activeAttempts) ? parsed.activeAttempts : [],
        // Pre-classification snapshots have no `category` key — default to "infra"
        // (the prior, uncategorized behavior) rather than losing the entry.
        retryQueue: Array.isArray(parsed.retryQueue)
          ? parsed.retryQueue.map((entry) => ({ ...entry, category: entry.category ?? "infra" }))
          : [],
      }
      logger.info("run-state-persistence", `Loaded run-state snapshot`, {
        activeAttempts: String(this.snapshot.activeAttempts.length),
        retryQueue: String(this.snapshot.retryQueue.length),
      })
    } catch {
      // File doesn't exist (first boot) or is corrupt — start fresh.
      // A corrupt/missing snapshot is not an error: it just means there
      // is nothing to recover, matching DagScheduler.loadCache().
      this.snapshot = emptySnapshot()
    }
    return this.snapshot
  }

  replaceActiveAttempts(attempts: PersistedAttempt[]): void {
    this.snapshot.activeAttempts = attempts
    this.persistAsync()
  }

  replaceRetryQueue(entries: PersistedRetryEntry[]): void {
    this.snapshot.retryQueue = entries
    this.persistAsync()
  }

  async flush(): Promise<void> {
    await this.writeQueue
  }

  /**
   * Write-then-rename: the snapshot is written to a sibling `.tmp` file
   * first, then atomically renamed over `storePath` (POSIX `rename(2)` is
   * atomic within the same filesystem). A crash mid-write only ever
   * leaves behind a half-written `.tmp` file — `storePath` itself always
   * either holds the previous complete snapshot or the new complete one,
   * never a truncated one. Without this, a crash during the old in-place
   * `writeFile` could truncate `storePath`, and `load()` treats a
   * corrupt file as "nothing to recover" (see `load()` above), silently
   * losing the entire active-attempts + retry-queue snapshot.
   */
  private async saveSnapshot(): Promise<void> {
    const tmpPath = `${this.storePath}.tmp`
    try {
      await mkdir(dirname(this.storePath), { recursive: true })
      this.snapshot.updatedAt = new Date().toISOString()
      await writeFile(tmpPath, JSON.stringify(this.snapshot, null, 2), "utf-8")
      await rename(tmpPath, this.storePath)
    } catch (err) {
      logger.error("run-state-persistence", "Failed to save run-state snapshot", { error: String(err) })
    }
  }

  /** Fire-and-forget persist through a serialized write queue (matches DagScheduler.persistAsync). */
  private persistAsync(): void {
    this.writeQueue = this.writeQueue
      .then(() => this.saveSnapshot())
      .catch((err) => {
        logger.error("run-state-persistence", "Async persist failed", { error: String(err) })
      })
  }
}
