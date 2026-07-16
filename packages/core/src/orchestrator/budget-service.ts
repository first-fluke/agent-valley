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
import type { BudgetUsagePort } from "./budget-persistence"
import { BudgetUsagePersistence } from "./budget-persistence"

// ── Public interface ──────────────────────────────────────────────────

export interface BudgetService {
  /** Gate invoked before each agent spawn. */
  checkBeforeSpawn(issue: Issue): Promise<BudgetDecision>
  /** Record a completed run's token usage (per-session adapter callback). */
  recordUsage(attemptId: string, issueId: string, usage: TokenUsage): Promise<void>
  /**
   * Mid-run enforcement gate — evaluates a streaming attempt's
   * running token count against the same per-issue / per-day caps used
   * by `checkBeforeSpawn`, without needing a completed `recordUsage`
   * call first. Callers (a streaming session/adapter) should invoke this
   * periodically as token deltas arrive and abort the run's RunHandle
   * when `allow === false`.
   *
   * Synchronous and side-effect free beyond logging: it only reads the
   * in-memory counters already maintained by `recordUsage` /
   * `checkBeforeSpawn`, so it is cheap to call on every streamed chunk.
   * `warn` mode always returns `allow: true` (matches `checkBeforeSpawn`).
   * Deliberately does not await `ready`: a run only reaches the streaming
   * phase this gate is called from after `checkBeforeSpawn` already
   * awaited hydration to admit the spawn, so by the time any
   * `checkMidRun` call happens `ready` has long since resolved.
   *
   * Follow-up wiring (out of scope here — sessions/ is owned elsewhere):
   * the streaming call site in `sessions/agent-runner.ts` (or the
   * relevant `AgentSession` adapter) should call
   * `budget.checkMidRun(issueId, tokensSoFar)` on each token-usage delta
   * event and, on `allow === false`, cancel the run via the existing
   * `RunHandle`/intervention abort path — the same path already used by
   * `InterventionBus.abort()`.
   *
   * Optional on the interface for backward compatibility with existing
   * hand-rolled `BudgetService` test fakes predating this method;
   * `createNoopBudgetService()` and `InMemoryBudgetService` both always
   * implement it. Callers that need mid-run enforcement should feature-
   * detect with `budget.checkMidRun?.(...)`.
   */
  checkMidRun?(issueId: string, tokensSoFar: number): BudgetDecision
  /** Read-only accessor: total tokens + USD consumed today (UTC). */
  getDailyUsed(): { tokens: number; usd: number }
  /** Read-only accessor: total tokens + USD consumed for one issue. */
  getIssueUsed(issueId: string): { tokens: number; usd: number }
  /**
   * Resolves once any persisted counters have been hydrated from disk.
   * Callers that construct a persisted service should `await` this
   * before the first `checkBeforeSpawn` so a restart cannot momentarily
   * under-report today's usage. `createNoopBudgetService()` and
   * `InMemoryBudgetService` both always implement it (already-resolved
   * when there is no persistence configured). Optional on the interface
   * for backward compatibility with existing hand-rolled `BudgetService`
   * test fakes predating this field — callers should guard with
   * `if (budget.ready) await budget.ready`.
   */
  readonly ready?: Promise<void>
  /**
   * Await any in-flight persisted-counter write so shutdown never returns
   * with a write still queued. Optional for backward compatibility with
   * hand-rolled test fakes predating this method; `createNoopBudgetService()`
   * and `InMemoryBudgetService` both always implement it (resolved
   * immediately when no persistence is configured). Callers should feature-
   * detect with `budget.flush?.()`.
   */
  flush?(): Promise<void>
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
  /**
   * Production convenience: when set, a `BudgetUsagePersistence` is
   * created at this path (matches the `.agent-valley/` convention — see
   * `budget-persistence.ts`) and counters are hydrated from it on
   * construction, then re-persisted on every `recordUsage()` call.
   * Ignored when `persistence` is also supplied.
   */
  persistPath?: string
  /** Test injection point — supply a fake `BudgetUsagePort` instead of a real file-backed one. Takes precedence over `persistPath`. */
  persistence?: BudgetUsagePort
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
    checkMidRun() {
      return { allow: true }
    },
    getDailyUsed() {
      return { tokens: 0, usd: 0 }
    },
    getIssueUsed() {
      return { tokens: 0, usd: 0 }
    },
    ready: Promise.resolve(),
    async flush() {
      // no-op
    },
  }
}

// ── Implementation ───────────────────────────────────────────────────

export class InMemoryBudgetService implements BudgetService {
  private readonly caps: BudgetCaps
  private readonly obs: ObservabilityHooks
  private readonly now: () => Date
  private readonly persistence: BudgetUsagePort | null
  readonly ready: Promise<void>

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
    this.persistence = opts.persistence ?? (opts.persistPath ? new BudgetUsagePersistence(opts.persistPath) : null)
    this.ready = this.persistence ? this.hydrate(this.persistence) : Promise.resolve()
  }

  /** Reload today's per-day counter + all per-issue counters from disk. Failures are logged and never thrown — a restart must still boot with zeroed counters rather than crash. */
  private async hydrate(persistence: BudgetUsagePort): Promise<void> {
    try {
      const snapshot = await persistence.load(this.currentDayKey())
      this.perDay.set(snapshot.dayKey, { ...snapshot.perDay })
      for (const [issueId, counter] of Object.entries(snapshot.perIssue)) {
        this.perIssue.set(issueId, { ...counter })
      }
    } catch (err) {
      logger.error("budget", "Failed to hydrate budget counters from disk — starting from zero", {
        error: String(err),
      })
    }
  }

  // ── Gate ───────────────────────────────────────────────────────────

  async checkBeforeSpawn(issue: Issue): Promise<BudgetDecision> {
    // Must wait for disk hydration to finish before reading perIssue/perDay —
    // otherwise a spawn issued during the boot window sees zeroed counters
    // (hydrate() hasn't populated them yet) and the daily/per-issue cap
    // carried over from before a restart is defeated.
    await this.ready

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
    if (issueDecision) return this.handleDeny(issue.id, issue.identifier, issueDecision)

    const dayDecision = evalCap("daily_cap", dayUsed, this.caps.perDay)
    if (dayDecision) return this.handleDeny(issue.id, issue.identifier, dayDecision)

    return { allow: true }
  }

  // ── Mid-run enforcement ──────────────────────────────────────────────

  /** See `BudgetService.checkMidRun` docstring for the intended call site. */
  checkMidRun(issueId: string, tokensSoFar: number): BudgetDecision {
    const projected = Math.max(0, tokensSoFar)
    const issueUsed = this.perIssue.get(issueId) ?? { tokens: 0, usd: 0 }
    const dayKey = this.currentDayKey()
    const dayUsed = this.perDay.get(dayKey) ?? { tokens: 0, usd: 0 }

    // Token-only projection: mid-stream we don't reliably know the final
    // model/pricing for USD cost, so mid-run enforcement is token-based
    // only. USD caps are still enforced post-run via checkBeforeSpawn on
    // the *next* spawn attempt once recordUsage has posted real cost.
    const projectedIssueTokens = issueUsed.tokens + projected
    if (this.caps.perIssue.tokens > 0 && projectedIssueTokens >= this.caps.perIssue.tokens) {
      return this.handleDeny(issueId, issueId, {
        allow: false,
        reason: "issue_cap",
        used: projectedIssueTokens,
        cap: this.caps.perIssue.tokens,
        unit: "tokens",
      })
    }

    const projectedDayTokens = dayUsed.tokens + projected
    if (this.caps.perDay.tokens > 0 && projectedDayTokens >= this.caps.perDay.tokens) {
      return this.handleDeny(issueId, issueId, {
        allow: false,
        reason: "daily_cap",
        used: projectedDayTokens,
        cap: this.caps.perDay.tokens,
        unit: "tokens",
      })
    }

    return { allow: true }
  }

  private handleDeny(
    issueId: string,
    identifier: string,
    decision: Exclude<BudgetDecision, { allow: true }>,
  ): BudgetDecision {
    // warn mode: log + allow regardless, but still emit the block counter
    // under a separate result so operators can distinguish from allows.
    if (this.caps.onExceed === "warn") {
      logger.warn("budget", "Budget cap reached (warn mode — allowing run)", {
        issueId,
        identifier,
        reason: decision.reason,
        used: String(decision.used),
        cap: String(decision.cap),
        unit: decision.unit,
      })
      this.incrementBlockCounter(decision.reason, "warn")
      return { allow: true }
    }

    logger.warn("budget", "Budget cap reached — blocking spawn", {
      issueId,
      identifier,
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
    // Must wait for hydration too: hydrate() assigns straight into
    // perIssue/perDay (see `hydrate()` above) rather than merging, so a
    // recordUsage() that lands mid-hydration would have its write clobbered
    // the moment hydrate()'s load() resolves.
    await this.ready

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
    this.persistCounters(dayKey, dayAgg)
  }

  /** Fire-and-forget mirror of the current counters to disk. No-op when no persistence is configured. */
  private persistCounters(dayKey: string, dayAgg: UsageCounter): void {
    if (!this.persistence) return
    this.persistence.save({
      dayKey,
      perDay: dayAgg,
      perIssue: Object.fromEntries(this.perIssue),
    })
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

  /** Await any in-flight persisted-counter write. No-op when no persistence is configured. */
  async flush(): Promise<void> {
    await this.persistence?.flush()
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
