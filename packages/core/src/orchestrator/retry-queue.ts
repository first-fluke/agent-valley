/**
 * Retry Queue — Exponential backoff retry scheduling with equal jitter,
 * per-failure-category attempt policy, dead-letter queue (DLQ) for
 * exhausted attempts, and retention-based expiration purging.
 *
 * Jitter: naive exponential backoff makes every failing issue retry at
 * exactly the same instants, so a shared upstream outage (Linear API,
 * git remote) produces synchronized retry storms (thundering herd) once
 * the outage clears. Equal jitter keeps the exponential growth but
 * randomizes each entry's actual delay within [delay/2, delay], so
 * concurrent failures fan out instead of re-converging.
 *
 * Category policy: MAST ("Why Do Multi-Agent LLM Systems Fail?",
 * arXiv:2503.13657) — infra, capability, and verification failures need
 * different remediation. Infra and verification failures get the full
 * configured retry budget (transient conditions and test/lint failures
 * are both plausibly fixed by another attempt). Capability failures
 * (agent produced nothing useful) get a shorter cap — re-running the
 * same incapable attempt rarely helps, so we escalate to cancelled sooner.
 *
 * Dead-Letter Queue & Retention:
 * Exhausted retries are retained in the dead-letter queue for operator
 * inspection or manual requeueing. Stale retries and dead-letter entries
 * exceeding `retentionMs` are automatically purged during queue drain or
 * explicit cleanup.
 */

import type { DeadLetterEntry, RetryCategory, RetryEntry } from "../domain/models"
import { logger } from "../observability/logger"

export type { DeadLetterEntry } from "../domain/models"

/** Prior-attempt context handed to a retry dispatch. */
export interface RetryContext {
  attemptCount: number
  lastError: string
  category?: RetryCategory
}

/** Ceiling on the (pre-jitter) exponential delay, so a high attemptCount can't grow the wait unboundedly. */
export const DEFAULT_MAX_BACKOFF_SEC = 3600

/** Capability-class failures are capped at this many queued attempts regardless of the configured maxAttempts (unless maxAttempts is already smaller). */
const CAPABILITY_MAX_ATTEMPTS = 2
export const CAPACITY_WAIT_REASON = "Concurrency limit reached"

/** Default retention period for dead-letter and stale retry entries: 7 days in milliseconds. */
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export class RetryQueue {
  private queue: RetryEntry[] = []
  private deadLetterQueue: DeadLetterEntry[] = []

  constructor(
    private maxAttempts: number,
    private backoffSec: number,
    /** Injectable RNG so jitter bounds are testable without flakiness. Defaults to Math.random. */
    private rng: () => number = Math.random,
    private maxBackoffSec: number = DEFAULT_MAX_BACKOFF_SEC,
    private retentionMs: number = DEFAULT_RETENTION_MS,
  ) {}

  get retention(): number {
    return this.retentionMs
  }

  /** Per-category attempt cap. Capability gets a shorter budget; infra/verification use the configured maxAttempts. */
  private maxAttemptsFor(category: RetryCategory): number {
    if (category === "capability") return Math.min(this.maxAttempts, CAPABILITY_MAX_ATTEMPTS)
    return this.maxAttempts
  }

  /**
   * Exponential delay (`backoffSec * 2^(attemptCount-1)`, capped at
   * `maxBackoffSec`), then equal-jittered: `delay/2 + random(0, delay/2)`.
   * Guarantees a minimum wait of `delay/2` (no near-instant retries) while
   * spreading the maximum wait across `[delay/2, delay]`.
   */
  private computeDelaySec(attemptCount: number): number {
    const raw = this.backoffSec * 2 ** Math.max(0, attemptCount - 1)
    const capped = Math.min(raw, this.maxBackoffSec)
    const half = capped / 2
    return half + this.rng() * half
  }

  /**
   * Record an issue in the dead-letter queue. Updates in place if already present.
   */
  private recordDeadLetter(entry: DeadLetterEntry): void {
    const existingIndex = this.deadLetterQueue.findIndex((e) => e.issueId === entry.issueId)
    if (existingIndex >= 0) {
      this.deadLetterQueue[existingIndex] = entry
    } else {
      this.deadLetterQueue.push(entry)
    }
  }

  /**
   * Purge retry entries and dead-letter entries that have exceeded retention.
   */
  purgeExpired(now: number = Date.now()): { purgedRetries: number; purgedDeadLetter: number } {
    const cutoff = now - this.retentionMs
    const initialDeadLetterLen = this.deadLetterQueue.length
    this.deadLetterQueue = this.deadLetterQueue.filter((e) => {
      const t = Date.parse(e.failedAt)
      return !Number.isNaN(t) && t >= cutoff
    })
    const purgedDeadLetter = initialDeadLetterLen - this.deadLetterQueue.length

    const initialQueueLen = this.queue.length
    this.queue = this.queue.filter((e) => {
      const t = Date.parse(e.nextRetryAt)
      return !Number.isNaN(t) && t >= cutoff
    })
    const purgedRetries = initialQueueLen - this.queue.length

    if (purgedDeadLetter > 0 || purgedRetries > 0) {
      logger.info("orchestrator", "Purged expired entries from retry/dead-letter queues", {
        purgedDeadLetter: String(purgedDeadLetter),
        purgedRetries: String(purgedRetries),
        remainingDeadLetter: String(this.deadLetterQueue.length),
        remainingRetries: String(this.queue.length),
      })
    }

    return { purgedRetries, purgedDeadLetter }
  }

  /**
   * @param category Failure classification driving the per-category max-attempts
   *   policy (see module docstring). Defaults to "infra" when a caller omits it,
   *   so existing 3-arg call sites keep their prior (infra) behavior unchanged.
   */
  add(issueId: string, attemptCount: number, lastError: string, category: RetryCategory = "infra"): boolean {
    const cap = this.maxAttemptsFor(category)
    if (attemptCount >= cap) {
      logger.error("orchestrator", "Max retry attempts reached for issue", {
        issueId,
        attemptCount: String(attemptCount),
        category,
        maxAttempts: String(cap),
      })
      this.queue = this.queue.filter((e) => e.issueId !== issueId)
      this.recordDeadLetter({
        issueId,
        attemptCount,
        failedAt: new Date().toISOString(),
        lastError,
        category,
      })
      return false
    }

    // Dedup: if already in queue, update instead of adding
    const existing = this.queue.find((e) => e.issueId === issueId)
    if (existing) {
      existing.attemptCount = Math.max(existing.attemptCount, attemptCount)
      existing.lastError = lastError
      existing.category = category
      const delaySec = this.computeDelaySec(existing.attemptCount)
      existing.nextRetryAt = new Date(Date.now() + delaySec * 1000).toISOString()

      logger.warn("orchestrator", "Retry updated (dedup)", {
        issueId,
        attemptCount: String(existing.attemptCount),
        category,
        nextRetryAt: existing.nextRetryAt,
      })

      return true
    }

    const delaySec = this.computeDelaySec(attemptCount)
    const nextRetryAt = new Date(Date.now() + delaySec * 1000).toISOString()

    this.queue.push({ issueId, attemptCount, nextRetryAt, lastError, category })
    // If it was in dead-letter, clear it now that it is queued again
    this.deadLetterQueue = this.deadLetterQueue.filter((e) => e.issueId !== issueId)

    logger.warn("orchestrator", "Retry scheduled", {
      issueId,
      attemptCount: String(attemptCount),
      category,
      nextRetryAt,
    })

    return true
  }

  /** Get entries that are ready to retry now. Purges expired entries first. */
  drain(): RetryEntry[] {
    this.purgeExpired()
    const now = new Date().toISOString()
    const ready: RetryEntry[] = []
    const remaining: RetryEntry[] = []

    for (const entry of this.queue) {
      if (entry.nextRetryAt <= now) {
        ready.push(entry)
      } else {
        remaining.push(entry)
      }
    }

    this.queue = remaining
    return ready
  }

  remove(issueId: string): void {
    this.queue = this.queue.filter((e) => e.issueId !== issueId)
  }

  get size(): number {
    return this.queue.length
  }

  get entries(): RetryEntry[] {
    return [...this.queue]
  }

  get deadLetter(): DeadLetterEntry[] {
    return [...this.deadLetterQueue]
  }

  get deadLetterSize(): number {
    return this.deadLetterQueue.length
  }

  getDeadLetter(issueId: string): DeadLetterEntry | undefined {
    return this.deadLetterQueue.find((e) => e.issueId === issueId)
  }

  removeDeadLetter(issueId: string): boolean {
    const initialLen = this.deadLetterQueue.length
    this.deadLetterQueue = this.deadLetterQueue.filter((e) => e.issueId !== issueId)
    return this.deadLetterQueue.length < initialLen
  }

  clearDeadLetter(): void {
    this.deadLetterQueue = []
  }

  restoreDeadLetter(entries: DeadLetterEntry[]): void {
    this.deadLetterQueue = [...entries]
    this.purgeExpired()
  }

  requeueDeadLetter(issueId: string): boolean {
    const entry = this.getDeadLetter(issueId)
    if (!entry) return false
    this.removeDeadLetter(issueId)
    return this.add(issueId, 0, `Re-queued from dead-letter queue: ${entry.lastError}`, entry.category)
  }
}
