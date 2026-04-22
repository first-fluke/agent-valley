/**
 * Budget domain types — cost and token accounting primitives used by the
 * Application-layer BudgetService (packages/core/src/orchestrator/budget-service.ts).
 *
 * This module is pure data. It must not import from Application,
 * Infrastructure, or Presentation (validate.sh enforces).
 *
 * Reference: docs/plans/v0-2-bigbang-design.md § 4.5, § 6.4.
 */

/** Pricing entry for a single model, expressed per 1 000 000 tokens. */
export interface ModelPricing {
  /** USD per 1M input tokens. */
  inputPerMtok: number
  /** USD per 1M output tokens. */
  outputPerMtok: number
}

/** Budget caps configuration resolved from valley.yaml (§ 4.5). */
export interface BudgetCaps {
  /** Per-issue caps. */
  perIssue: { tokens: number; usd: number }
  /** Per-day caps (UTC 00:00 rollover). */
  perDay: { tokens: number; usd: number }
  /**
   * Behavior when a cap is exceeded before spawn.
   *   - "block": deny spawn, post comment, cancel issue via existing path.
   *   - "warn":  allow spawn, emit WARN log + audit.
   */
  onExceed: "block" | "warn"
  /**
   * When true, an issue carrying the `override:budget` label bypasses all
   * caps (audit-logged). When false, the label is ignored.
   */
  allowOverrideLabel: boolean
  /** Pricing map keyed by model identifier. Missing models are priced at 0 + WARN. */
  pricing: Record<string, ModelPricing>
}

/**
 * Decision returned by BudgetService.checkBeforeSpawn().
 *
 *   - allow=true  → caller proceeds with spawn.
 *   - allow=false → caller posts comment + cancels (block mode). `unit`
 *                   distinguishes token-based from USD-based trigger so the
 *                   comment text can be precise.
 */
export type BudgetDecision =
  | { allow: true }
  | {
      allow: false
      reason: "issue_cap" | "daily_cap"
      used: number
      cap: number
      unit: "tokens" | "usd"
    }

/** Raw usage reported by a session adapter after a run. */
export interface TokenUsage {
  input: number
  output: number
  /** Model identifier used for this run (matched against BudgetCaps.pricing). */
  model: string
}

/** Single accounting entry recorded inside BudgetService. */
export interface BudgetUsage {
  attemptId: string
  issueId: string
  tokens: number
  costUsd: number
  model: string
  /** ISO-8601 timestamp (UTC). */
  recordedAt: string
}

/** Override label that bypasses caps when BudgetCaps.allowOverrideLabel is true. */
export const BUDGET_OVERRIDE_LABEL = "override:budget"
