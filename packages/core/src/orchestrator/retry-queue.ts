/**
 * Retry Queue — Exponential backoff retry scheduling.
 */

import type { RetryEntry } from "../domain/models"
import { logger } from "../observability/logger"

export class RetryQueue {
  private queue: RetryEntry[] = []

  constructor(
    private maxAttempts: number,
    private backoffSec: number,
  ) {}

  add(issueId: string, attemptCount: number, lastError: string): boolean {
    if (attemptCount >= this.maxAttempts) {
      logger.error("orchestrator", `Max retry attempts reached for issue`, {
        issueId,
        attemptCount: String(attemptCount),
      })
      return false
    }

    // Dedup: if already in queue, update instead of adding
    const existing = this.queue.find((e) => e.issueId === issueId)
    if (existing) {
      existing.attemptCount = Math.max(existing.attemptCount, attemptCount)
      existing.lastError = lastError
      const delay = this.backoffSec * 2 ** (existing.attemptCount - 1)
      existing.nextRetryAt = new Date(Date.now() + delay * 1000).toISOString()

      logger.warn("orchestrator", "Retry updated (dedup)", {
        issueId,
        attemptCount: String(existing.attemptCount),
        nextRetryAt: existing.nextRetryAt,
      })

      return true
    }

    const delay = this.backoffSec * 2 ** (attemptCount - 1)
    const nextRetryAt = new Date(Date.now() + delay * 1000).toISOString()

    this.queue.push({ issueId, attemptCount, nextRetryAt, lastError })

    logger.warn("orchestrator", "Retry scheduled", {
      issueId,
      attemptCount: String(attemptCount),
      nextRetryAt,
    })

    return true
  }

  /** Get entries that are ready to retry now. */
  drain(): RetryEntry[] {
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
}
