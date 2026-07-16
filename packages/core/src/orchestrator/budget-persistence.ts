/**
 * BudgetUsagePersistence — durable JSON snapshot of BudgetService's
 * per-day / per-issue token+USD counters, so a process restart cannot
 * silently reset the daily budget cap.
 *
 * Mirrors the `.agent-valley/` JSON-cache convention used by
 * DagScheduler (../orchestrator/dag-scheduler.ts) and RunStatePersistence
 * (./persistence/run-state-store.ts): same directory, same serialized
 * fire-and-forget write queue, same load-or-default-on-missing-or-corrupt
 * behavior. Implemented as a small self-contained module here (rather
 * than importing persistence/run-state-store.ts directly) to avoid
 * coupling budget-service.ts to another in-flight component during
 * concurrent development on this repo.
 *
 * Reference: docs/plans/v0-2-bigbang-design.md § 4.5, § 6.4 (E16-E19).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { logger } from "../observability/logger"

export interface BudgetUsageCounter {
  tokens: number
  usd: number
}

export interface BudgetUsageSnapshot {
  version: 1
  updatedAt: string
  /** "YYYY-MM-DD" (UTC) the persisted `perDay` counter belongs to. */
  dayKey: string
  perDay: BudgetUsageCounter
  perIssue: Record<string, BudgetUsageCounter>
}

function emptySnapshot(dayKey: string): BudgetUsageSnapshot {
  return { version: 1, updatedAt: "", dayKey, perDay: { tokens: 0, usd: 0 }, perIssue: {} }
}

/**
 * Narrow port BudgetService depends on, so tests can inject an in-memory
 * fake instead of touching the real filesystem.
 */
export interface BudgetUsagePort {
  /**
   * Load the snapshot. `currentDayKey` is passed in so rollover can be
   * decided here: a persisted `perDay` counter belonging to a prior UTC
   * day is discarded (reset to zero) instead of leaking into today's
   * cap. `perIssue` is not date-scoped and is always restored as-is.
   */
  load(currentDayKey: string): Promise<BudgetUsageSnapshot>
  /** Fire-and-forget persist through a serialized write queue. */
  save(snapshot: { dayKey: string; perDay: BudgetUsageCounter; perIssue: Record<string, BudgetUsageCounter> }): void
  /** Await any in-flight writes. Test-only convenience. */
  flush(): Promise<void>
}

export class BudgetUsagePersistence implements BudgetUsagePort {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly storePath: string) {}

  async load(currentDayKey: string): Promise<BudgetUsageSnapshot> {
    try {
      const raw = await readFile(this.storePath, "utf-8")
      const parsed = JSON.parse(raw) as Partial<BudgetUsageSnapshot>
      const perIssue =
        parsed.perIssue && typeof parsed.perIssue === "object"
          ? (parsed.perIssue as Record<string, BudgetUsageCounter>)
          : {}
      const rolledOver = parsed.dayKey !== currentDayKey
      const perDay = !rolledOver && parsed.perDay ? parsed.perDay : { tokens: 0, usd: 0 }

      logger.info("budget-persistence", "Loaded budget-usage snapshot", {
        dayKey: currentDayKey,
        rolledOver: String(rolledOver),
        perDayTokens: String(perDay.tokens),
        perDayUsd: String(perDay.usd),
        perIssueCount: String(Object.keys(perIssue).length),
      })

      return { version: 1, updatedAt: parsed.updatedAt ?? "", dayKey: currentDayKey, perDay, perIssue }
    } catch {
      // File doesn't exist (first boot) or is corrupt — start fresh. Not
      // an error: there is simply nothing to recover, matching
      // DagScheduler.loadCache() / RunStatePersistence.load().
      return emptySnapshot(currentDayKey)
    }
  }

  save(snapshot: { dayKey: string; perDay: BudgetUsageCounter; perIssue: Record<string, BudgetUsageCounter> }): void {
    this.writeQueue = this.writeQueue
      .then(() => this.persist(snapshot))
      .catch((err) => {
        logger.error("budget-persistence", "Async persist failed", { error: String(err) })
      })
  }

  private async persist(snapshot: {
    dayKey: string
    perDay: BudgetUsageCounter
    perIssue: Record<string, BudgetUsageCounter>
  }): Promise<void> {
    try {
      await mkdir(dirname(this.storePath), { recursive: true })
      const full: BudgetUsageSnapshot = { version: 1, updatedAt: new Date().toISOString(), ...snapshot }
      // Atomic write: a crash mid-write can only leave a stray `.tmp`; the
      // live snapshot is never truncated (matches RunStatePersistence).
      const tmpPath = `${this.storePath}.tmp`
      await writeFile(tmpPath, JSON.stringify(full, null, 2), "utf-8")
      await rename(tmpPath, this.storePath)
    } catch (err) {
      logger.error("budget-persistence", "Failed to save budget-usage snapshot", { error: String(err) })
    }
  }

  async flush(): Promise<void> {
    await this.writeQueue
  }
}
