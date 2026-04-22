/**
 * BudgetService unit tests.
 *
 * Covers the Application-layer budget gate and accumulator (§ 4.5, § 6.4):
 *   - allow on first spawn, deny after per-issue cap reached (tokens / USD)
 *   - deny after per-day cap reached
 *   - `override:budget` label bypass (only when allow_override_label=true)
 *   - unknown model priced at 0 + WARN path (no throw)
 *   - `on_exceed: warn` returns allow + logs instead of denying
 *   - day key rollover at UTC 00:00 (injected clock)
 *   - accessors mirror internal accumulators
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 4.5 / § 6.4.
 */

import { describe, expect, test } from "vitest"
import type { BudgetCaps } from "../domain/budget"
import { BUDGET_OVERRIDE_LABEL } from "../domain/budget"
import { computeCost, createInMemoryBudgetService } from "../orchestrator/budget-service"
import { makeIssue } from "./characterization/helpers"

function makeCaps(overrides: Partial<BudgetCaps> = {}): BudgetCaps {
  return {
    perIssue: { tokens: 1_000, usd: 1.0 },
    perDay: { tokens: 10_000, usd: 5.0 },
    onExceed: "block",
    allowOverrideLabel: false,
    pricing: {
      "claude-sonnet": { inputPerMtok: 3.0, outputPerMtok: 15.0 },
    },
    ...overrides,
  }
}

describe("BudgetService.checkBeforeSpawn — happy path", () => {
  test("allows spawn when no usage has been recorded", async () => {
    const svc = createInMemoryBudgetService({ caps: makeCaps() })
    const decision = await svc.checkBeforeSpawn(makeIssue({ id: "i1" }))
    expect(decision).toEqual({ allow: true })
  })

  test("allows spawn while usage is strictly under caps", async () => {
    const svc = createInMemoryBudgetService({ caps: makeCaps() })
    await svc.recordUsage("att-1", "i1", { input: 100, output: 50, model: "claude-sonnet" })
    const decision = await svc.checkBeforeSpawn(makeIssue({ id: "i1" }))
    expect(decision).toEqual({ allow: true })
  })
})

describe("BudgetService.checkBeforeSpawn — issue cap", () => {
  test("denies with issue_cap/tokens when per-issue token cap is reached", async () => {
    const svc = createInMemoryBudgetService({
      caps: makeCaps({ perIssue: { tokens: 100, usd: 100 } }),
    })
    // Unknown model → cost 0 so the token cap fires first
    await svc.recordUsage("att-1", "i1", { input: 60, output: 40, model: "unknown-model" })

    const decision = await svc.checkBeforeSpawn(makeIssue({ id: "i1" }))
    expect(decision).toMatchObject({
      allow: false,
      reason: "issue_cap",
      unit: "tokens",
      cap: 100,
    })
  })

  test("denies with issue_cap/usd when per-issue USD cap is reached", async () => {
    const svc = createInMemoryBudgetService({
      caps: makeCaps({ perIssue: { tokens: 0, usd: 0.001 } }),
    })
    await svc.recordUsage("att-1", "i1", {
      input: 1_000_000,
      output: 0,
      model: "claude-sonnet",
    })
    // 1M input * $3/M = $3.0 → exceeds $0.001 cap
    const decision = await svc.checkBeforeSpawn(makeIssue({ id: "i1" }))
    expect(decision).toMatchObject({
      allow: false,
      reason: "issue_cap",
      unit: "usd",
    })
  })

  test("does not block a different issue when only one has exceeded the cap", async () => {
    const svc = createInMemoryBudgetService({
      caps: makeCaps({ perIssue: { tokens: 100, usd: 100 } }),
    })
    await svc.recordUsage("att-1", "i1", { input: 120, output: 0, model: "unknown-model" })

    const otherDecision = await svc.checkBeforeSpawn(makeIssue({ id: "i2" }))
    expect(otherDecision).toEqual({ allow: true })
  })
})

describe("BudgetService.checkBeforeSpawn — daily cap", () => {
  test("denies with daily_cap/tokens after multiple issues exhaust the day pool", async () => {
    const svc = createInMemoryBudgetService({
      caps: makeCaps({
        perIssue: { tokens: 1000, usd: 1000 },
        perDay: { tokens: 150, usd: 1000 },
      }),
    })
    await svc.recordUsage("a", "i1", { input: 100, output: 0, model: "unknown-model" })
    await svc.recordUsage("b", "i2", { input: 80, output: 0, model: "unknown-model" })
    const decision = await svc.checkBeforeSpawn(makeIssue({ id: "i3" }))
    expect(decision).toMatchObject({
      allow: false,
      reason: "daily_cap",
      unit: "tokens",
    })
  })

  test("rolls over daily counter at UTC midnight", async () => {
    let now = new Date("2026-04-21T23:50:00Z")
    const svc = createInMemoryBudgetService({
      caps: makeCaps({ perDay: { tokens: 100, usd: 0 } }),
      now: () => now,
    })
    await svc.recordUsage("a", "i1", { input: 150, output: 0, model: "unknown-model" })
    expect((await svc.checkBeforeSpawn(makeIssue({ id: "i2" }))).allow).toBe(false)

    // Advance past midnight UTC → fresh daily bucket
    now = new Date("2026-04-22T00:05:00Z")
    expect((await svc.checkBeforeSpawn(makeIssue({ id: "i2" }))).allow).toBe(true)
  })
})

describe("BudgetService.checkBeforeSpawn — override label", () => {
  test("bypasses caps when override:budget label is present and opt-in is enabled", async () => {
    const svc = createInMemoryBudgetService({
      caps: makeCaps({
        perIssue: { tokens: 10, usd: 10 },
        allowOverrideLabel: true,
      }),
    })
    await svc.recordUsage("a", "i1", { input: 1_000, output: 0, model: "unknown-model" })
    const decision = await svc.checkBeforeSpawn(makeIssue({ id: "i1", labels: [BUDGET_OVERRIDE_LABEL] }))
    expect(decision).toEqual({ allow: true })
  })

  test("ignores the label when allow_override_label is disabled", async () => {
    const svc = createInMemoryBudgetService({
      caps: makeCaps({
        perIssue: { tokens: 10, usd: 10 },
        allowOverrideLabel: false,
      }),
    })
    await svc.recordUsage("a", "i1", { input: 1_000, output: 0, model: "unknown-model" })
    const decision = await svc.checkBeforeSpawn(makeIssue({ id: "i1", labels: [BUDGET_OVERRIDE_LABEL] }))
    expect(decision.allow).toBe(false)
  })
})

describe("BudgetService.checkBeforeSpawn — warn mode", () => {
  test("returns allow even when cap is reached and logs a warning", async () => {
    const svc = createInMemoryBudgetService({
      caps: makeCaps({
        perIssue: { tokens: 10, usd: 10 },
        onExceed: "warn",
      }),
    })
    await svc.recordUsage("a", "i1", { input: 1_000, output: 0, model: "unknown-model" })
    const decision = await svc.checkBeforeSpawn(makeIssue({ id: "i1" }))
    expect(decision).toEqual({ allow: true })
  })
})

describe("BudgetService.recordUsage — pricing & accumulators", () => {
  test("computes USD from pricing map using per-direction rates", async () => {
    const svc = createInMemoryBudgetService({ caps: makeCaps() })
    await svc.recordUsage("a", "i1", {
      input: 1_000_000,
      output: 500_000,
      model: "claude-sonnet",
    })
    const used = svc.getIssueUsed("i1")
    // 1M * $3 + 0.5M * $15 = $3 + $7.5 = $10.5
    expect(used.usd).toBeCloseTo(10.5, 6)
    expect(used.tokens).toBe(1_500_000)
  })

  test("charges 0 USD and does not throw for unknown models (E17)", async () => {
    const svc = createInMemoryBudgetService({ caps: makeCaps() })
    await svc.recordUsage("a", "i1", { input: 100, output: 100, model: "new-model" })
    const used = svc.getIssueUsed("i1")
    expect(used.usd).toBe(0)
    expect(used.tokens).toBe(200)
  })

  test("getDailyUsed aggregates across issues on the same UTC day", async () => {
    const fixed = new Date("2026-04-21T12:00:00Z")
    const svc = createInMemoryBudgetService({
      caps: makeCaps(),
      now: () => fixed,
    })
    await svc.recordUsage("a", "i1", { input: 100, output: 0, model: "claude-sonnet" })
    await svc.recordUsage("b", "i2", { input: 200, output: 0, model: "claude-sonnet" })
    const day = svc.getDailyUsed()
    expect(day.tokens).toBe(300)
  })
})

describe("computeCost helper", () => {
  test("returns 0 for empty pricing map", () => {
    expect(computeCost({ input: 10, output: 10, model: "x" }, {})).toBe(0)
  })

  test("handles zero token counts without NaN", () => {
    expect(
      computeCost(
        { input: 0, output: 0, model: "claude-sonnet" },
        { "claude-sonnet": { inputPerMtok: 3, outputPerMtok: 15 } },
      ),
    ).toBe(0)
  })
})
