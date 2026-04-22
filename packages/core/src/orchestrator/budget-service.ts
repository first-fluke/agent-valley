/**
 * BudgetService — Per-issue and per-day token / USD cap accounting for
 * agent runs. Application layer (NOT a domain port — see design § 4.5).
 *
 * Responsibilities:
 *   - checkBeforeSpawn(issue): compute current used + projected, return
 *     allow/deny. `override:budget` label can opt-in bypass (audit).
 *   - recordUsage(attemptId, usage): add tokens and derived USD cost to
 *     the per-issue + daily counters. Emit gauge / counter metrics.
 *   - getDailyUsed / getIssueUsed: accessors used by tests and status
 *     surfaces.
 *
 * Concurrency: single-process, single-threaded (Bun). Internal maps are
 * mutated under the BudgetService instance only. Not exported to other
 * application components — only Orchestrator holds the reference.
 *
 * Reference: docs/plans/v0-2-bigbang-design.md § 4.5, § 6.4 (E16–E19).
 */

import type { BudgetCaps, BudgetDecision, BudgetUsage, TokenUsage } from "../domain/budget"
import { BUDGET_OVERRIDE_LABEL } from "../domain/budget"
import type { Issue } from "../domain/models"
import type { ObservabilityHooks } from "../observability/hooks"
import { createNoopObservabilityHooks } from "../observability/hooks"
import { logger } from "../observability/logger"

// ── Public interface ──────────────────────────────────────────────────

export interface BudgetService {
  /** Gate invoked before each agent spawn. */
  checkBeforeSpawn(issue: Issue): Promise<BudgetDecision>
  /** Record a completed run's token usage (per-session adapter callback). */
  recordUsage(attemptId: string, issueId: string, usage: TokenUsage): Promise<void>
  /** Read-only accessor: total tokens + USD consumed today (UTC). */
  getDailyUsed(): { tokens: number; usd: number }
  /** Read-only accessor: total tokens + USD consumed for one issue. */
  getIssueUsed(issueId: string): { tokens: number; usd: number }
}

// ── Internal accumulator shape ───────────────────────────────────────

interface UsageCounter {
  tokens: number
  usd: number
}

// ── Factory ──────────────────────────────────────────────────────────

export interface BudgetServiceOptions {
  caps: BudgetCaps
  observability?: ObservabilityHooks
  /** Injection point for tests that need a deterministic clock. */
  now?: () => Date
}

/**
 * Build an in-memory BudgetService. When no caps are configured (i.e. the
 * budget section is absent from valley.yaml) callers should use
 * `createNoopBudgetService()` instead so allow is always returned.
 */
export function createInMemoryBudgetService(opts: BudgetServiceOptions): BudgetService {
  return new InMemoryBudgetService(opts)
}

/** No-op fallback used when `budget` is not configured in valley.yaml. */
export function createNoopBudgetService(): BudgetService {
  return {
    async checkBeforeSpawn() {
      return { allow: true }
    },
    async recordUsage() {
      // no-op
    },
    getDailyUsed() {
      return { tokens: 0, usd: 0 }
    },
    getIssueUsed() {
      return { tokens: 0, usd: 0 }
    },
  }
}

// ── Implementation ───────────────────────────────────────────────────

export class InMemoryBudgetService implements BudgetService {
  private readonly caps: BudgetCaps
  private readonly obs: ObservabilityHooks
  private readonly now: () => Date

  /** issueId -> running totals. */
  private readonly perIssue = new Map<string, UsageCounter>()
  /** "YYYY-MM-DD" (UTC) -> running totals. */
  private readonly perDay = new Map<string, UsageCounter>()
  /** History (retained mostly for tests; not rendered anywhere). */
  private readonly history: BudgetUsage[] = []

  constructor(opts: BudgetServiceOptions) {
    this.caps = opts.caps
    this.obs = opts.observability ?? createNoopObservabilityHooks()
    this.now = opts.now ?? (() => new Date())
  }

  // ── Gate ───────────────────────────────────────────────────────────

  async checkBeforeSpawn(issue: Issue): Promise<BudgetDecision> {
    // Override label opt-in: documented bypass with audit log (E18).
    if (this.caps.allowOverrideLabel && issue.labels.includes(BUDGET_OVERRIDE_LABEL)) {
      logger.info("budget", "Budget bypassed via override:budget label", {
        issueId: issue.id,
        identifier: issue.identifier,
        auditReason: "override_label",
      })
      return { allow: true }
    }

    const issueUsed = this.perIssue.get(issue.id) ?? { tokens: 0, usd: 0 }
    const dayKey = this.currentDayKey()
    const dayUsed = this.perDay.get(dayKey) ?? { tokens: 0, usd: 0 }

    // Evaluate in order: per-issue first (more specific), then per-day.
    const issueDecision = evalCap("issue_cap", issueUsed, this.caps.perIssue)
    if (issueDecision) return this.handleDeny(issue, issueDecision)

    const dayDecision = evalCap("daily_cap", dayUsed, this.caps.perDay)
    if (dayDecision) return this.handleDeny(issue, dayDecision)

    return { allow: true }
  }

  private handleDeny(issue: Issue, decision: Exclude<BudgetDecision, { allow: true }>): BudgetDecision {
    // warn mode: log + allow regardless, but still emit the block counter
    // under a separate result so operators can distinguish from allows.
    if (this.caps.onExceed === "warn") {
      logger.warn("budget", "Budget cap reached (warn mode — allowing run)", {
        issueId: issue.id,
        identifier: issue.identifier,
        reason: decision.reason,
        used: String(decision.used),
        cap: String(decision.cap),
        unit: decision.unit,
      })
      this.incrementBlockCounter(decision.reason, "warn")
      return { allow: true }
    }

    logger.warn("budget", "Budget cap reached — blocking spawn", {
      issueId: issue.id,
      identifier: issue.identifier,
      reason: decision.reason,
      used: String(decision.used),
      cap: String(decision.cap),
      unit: decision.unit,
    })
    this.incrementBlockCounter(decision.reason, "block")
    return decision
  }

  // ── Record ────────────────────────────────────────────────────────

  async recordUsage(attemptId: string, issueId: string, usage: TokenUsage): Promise<void> {
    const tokens = Math.max(0, (usage.input ?? 0) + (usage.output ?? 0))
    const cost = computeCost(usage, this.caps.pricing)

    // Per-issue accumulator
    const issueAgg = this.perIssue.get(issueId) ?? { tokens: 0, usd: 0 }
    issueAgg.tokens += tokens
    issueAgg.usd += cost
    this.perIssue.set(issueId, issueAgg)

    // Per-day accumulator (UTC)
    const dayKey = this.currentDayKey()
    const dayAgg = this.perDay.get(dayKey) ?? { tokens: 0, usd: 0 }
    dayAgg.tokens += tokens
    dayAgg.usd += cost
    this.perDay.set(dayKey, dayAgg)

    this.history.push({
      attemptId,
      issueId,
      tokens,
      costUsd: cost,
      model: usage.model,
      recordedAt: this.now().toISOString(),
    })

    this.updateGauges(issueId, dayKey, issueAgg, dayAgg)
  }

  // ── Accessors ─────────────────────────────────────────────────────

  getDailyUsed(): { tokens: number; usd: number } {
    const dayKey = this.currentDayKey()
    const agg = this.perDay.get(dayKey) ?? { tokens: 0, usd: 0 }
    return { tokens: agg.tokens, usd: agg.usd }
  }

  getIssueUsed(issueId: string): { tokens: number; usd: number } {
    const agg = this.perIssue.get(issueId) ?? { tokens: 0, usd: 0 }
    return { tokens: agg.tokens, usd: agg.usd }
  }

  // ── Internal helpers ─────────────────────────────────────────────

  private currentDayKey(): string {
    // YYYY-MM-DD in UTC; Map rolls over naturally at 00:00 UTC.
    return this.now().toISOString().slice(0, 10)
  }

  private updateGauges(issueId: string, dayKey: string, issueAgg: UsageCounter, dayAgg: UsageCounter): void {
    try {
      this.obs.metrics.gauge("av_budget_used_usd", { scope: `issue:${issueId}` }).set(issueAgg.usd)
      this.obs.metrics.gauge("av_budget_used_usd", { scope: `day:${dayKey}` }).set(dayAgg.usd)
    } catch {
      // Metrics must never break orchestrator flow. The prom-metrics
      // module already guards via its own try/catch wrappers; this is
      // belt + suspenders for future exporter implementations.
    }
  }

  private incrementBlockCounter(reason: "issue_cap" | "daily_cap", mode: "block" | "warn"): void {
    try {
      this.obs.metrics.counter("av_budget_blocks_total", { reason, mode }).inc()
    } catch {
      // swallow — observability errors must not interrupt control flow
    }
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────

function evalCap(
  reason: "issue_cap" | "daily_cap",
  used: UsageCounter,
  cap: { tokens: number; usd: number },
): Exclude<BudgetDecision, { allow: true }> | null {
  if (cap.tokens > 0 && used.tokens >= cap.tokens) {
    return { allow: false, reason, used: used.tokens, cap: cap.tokens, unit: "tokens" }
  }
  if (cap.usd > 0 && used.usd >= cap.usd) {
    return { allow: false, reason, used: used.usd, cap: cap.usd, unit: "usd" }
  }
  return null
}

/**
 * Compute USD cost for a TokenUsage using the pricing map. Unknown models
 * fall back to 0 with a WARN log (E17). Input / output are treated as
 * independent line items so per-direction pricing is supported.
 */
export function computeCost(
  usage: TokenUsage,
  pricing: Record<string, { inputPerMtok: number; outputPerMtok: number }>,
): number {
  const entry = pricing[usage.model]
  if (!entry) {
    logger.warn("budget", "Unknown model in pricing map — charging 0 USD", {
      model: usage.model,
      availableModels: Object.keys(pricing).join(",") || "(none)",
      fix: "Add the model to budget.pricing in valley.yaml",
    })
    return 0
  }
  const input = (usage.input ?? 0) * entry.inputPerMtok
  const output = (usage.output ?? 0) * entry.outputPerMtok
  return (input + output) / 1_000_000
}

/**
 * Format a human-readable message body for a budget-cap comment posted to
 * the tracker. Kept as a pure helper so the orchestrator integration and
 * tests share wording.
 */
export function formatBudgetBlockComment(
  decision: Exclude<BudgetDecision, { allow: true }>,
  identifier: string,
): string {
  const scope = decision.reason === "issue_cap" ? "per-issue" : "per-day"
  const unit = decision.unit === "usd" ? "USD" : "tokens"
  const used = decision.unit === "usd" ? decision.used.toFixed(4) : String(decision.used)
  const cap = decision.unit === "usd" ? decision.cap.toFixed(4) : String(decision.cap)
  return (
    `Symphony: budget cap reached for ${identifier} (${scope}).\n` +
    `  Used: ${used} ${unit}\n` +
    `  Cap:  ${cap} ${unit}\n` +
    `  Fix: raise budget.${decision.reason === "issue_cap" ? "per_issue" : "per_day"}.${decision.unit} in valley.yaml, ` +
    `or add the "${BUDGET_OVERRIDE_LABEL}" label and enable budget.allow_override_label.`
  )
}
