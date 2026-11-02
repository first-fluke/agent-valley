/**
 * SqliteBudgetUsageStore — BudgetUsagePort over the state database. The
 * per-day counter, per-issue counters and recorded attempt ids are replaced
 * together in one transaction on every save.
 */

import { logger } from "../observability/logger"
import {
  type BudgetUsageCounter,
  BudgetUsagePersistence,
  type BudgetUsagePort,
  type BudgetUsageSnapshot,
} from "../orchestrator/budget-persistence"
import { importLegacySnapshot } from "./legacy-json"
import type { StateDatabase } from "./state-database"

type SaveInput = Parameters<BudgetUsagePort["save"]>[0]

export class SqliteBudgetUsageStore implements BudgetUsagePort {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly db: StateDatabase,
    /** `budget-usage.json` of earlier builds; imported once, then renamed. */
    private readonly legacyPath?: string,
  ) {}

  async load(currentDayKey: string): Promise<BudgetUsageSnapshot> {
    await importLegacySnapshot(this.db, "budget_usage", this.legacyPath, async () => {
      if (!this.legacyPath) return
      const legacy = await new BudgetUsagePersistence(this.legacyPath).load(currentDayKey)
      await this.db.write(this.statements(legacy))
    })

    const [day, issues, attempts] = await Promise.all([
      this.db.execute({ sql: "SELECT * FROM budget_day_usage", args: [] }),
      this.db.execute({ sql: "SELECT * FROM budget_issue_usage", args: [] }),
      this.db.execute({ sql: "SELECT attempt_id FROM budget_recorded_attempts", args: [] }),
    ])
    const dayRow = day.rows[0]
    // A counter from a prior UTC day must not leak into today's cap.
    const rolledOver = dayRow === undefined || String(dayRow.day_key) !== currentDayKey
    const perDay: BudgetUsageCounter =
      !rolledOver && dayRow ? { tokens: Number(dayRow.tokens), usd: Number(dayRow.usd) } : { tokens: 0, usd: 0 }
    const perIssue: Record<string, BudgetUsageCounter> = {}
    for (const row of issues.rows) {
      perIssue[String(row.issue_id)] = { tokens: Number(row.tokens), usd: Number(row.usd) }
    }
    logger.info("budget-persistence", "Loaded budget usage from the state database", {
      dayKey: currentDayKey,
      rolledOver: String(rolledOver),
      perIssueCount: String(Object.keys(perIssue).length),
    })
    return {
      version: 1,
      updatedAt: "",
      dayKey: currentDayKey,
      perDay,
      perIssue,
      recordedAttemptIds: attempts.rows.map((row) => String(row.attempt_id)),
    }
  }

  save(snapshot: SaveInput): void {
    const statements = this.statements(snapshot)
    this.writeQueue = this.writeQueue
      .then(() => this.db.write(statements))
      .catch((err) => {
        logger.error("budget-persistence", "Failed to save budget usage to the state database", {
          error: String(err),
        })
      })
  }

  async flush(): Promise<void> {
    await this.writeQueue
  }

  private statements(snapshot: SaveInput) {
    return [
      { sql: "DELETE FROM budget_day_usage", args: [] },
      { sql: "DELETE FROM budget_issue_usage", args: [] },
      { sql: "DELETE FROM budget_recorded_attempts", args: [] },
      {
        sql: "INSERT INTO budget_day_usage (day_key, tokens, usd) VALUES (?, ?, ?)",
        args: [snapshot.dayKey, snapshot.perDay.tokens, snapshot.perDay.usd],
      },
      ...Object.entries(snapshot.perIssue).map(([issueId, counter]) => ({
        sql: "INSERT INTO budget_issue_usage (issue_id, tokens, usd) VALUES (?, ?, ?)",
        args: [issueId, counter.tokens, counter.usd],
      })),
      ...(snapshot.recordedAttemptIds ?? []).map((attemptId) => ({
        sql: "INSERT INTO budget_recorded_attempts (attempt_id) VALUES (?)",
        args: [attemptId],
      })),
    ]
  }
}
