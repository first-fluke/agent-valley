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
import type { BudgetCaps, BudgetDecision } from "../domain/budget"
import { BUDGET_OVERRIDE_LABEL } from "../domain/budget"
import type { BudgetUsagePort, BudgetUsageSnapshot } from "../orchestrator/budget-persistence"
import type { BudgetService } from "../orchestrator/budget-service"
import { computeCost, createInMemoryBudgetService, createNoopBudgetService } from "../orchestrator/budget-service"
import { makeIssue } from "./characterization/helpers"

/**
 * `checkMidRun` / `ready` are optional on `BudgetService` for backward
 * compatibility with older hand-rolled fakes elsewhere in the test
 * suite — `createInMemoryBudgetService` / `createNoopBudgetService`
 * always implement both. These helpers assert that at the test
 * boundary instead of using a forbidden non-null assertion at each
 * call site (see .agents/rules/quality.md / biome lint/style/noNonNullAssertion).
 */
function readyOf(svc: BudgetService): Promise<void> {
  if (!svc.ready) throw new Error("expected BudgetService.ready to be defined on this implementation")
  return svc.ready
}
function checkMidRunOf(svc: BudgetService): (issueId: string, tokensSoFar: number) => BudgetDecision {
  if (!svc.checkMidRun) throw new Error("expected BudgetService.checkMidRun to be defined on this implementation")
  return svc.checkMidRun.bind(svc)
}

/** In-memory fake BudgetUsagePort — avoids touching the filesystem in unit tests. */
function makeFakePersistence(
  initial?: Partial<BudgetUsageSnapshot>,
): BudgetUsagePort & { savedCalls: unknown[]; flushCalls: number } {
  const savedCalls: unknown[] = []
  let flushCalls = 0
  let stored: BudgetUsageSnapshot = {
    version: 1,
    updatedAt: "",
    dayKey: initial?.dayKey ?? "",
    perDay: initial?.perDay ?? { tokens: 0, usd: 0 },
    perIssue: initial?.perIssue ?? {},
  }
  return {
    savedCalls,
    get flushCalls() {
      return flushCalls
    },
    async load(currentDayKey: string) {
      const rolledOver = stored.dayKey !== currentDayKey
      return {
        version: 1,
        updatedAt: stored.updatedAt,
        dayKey: currentDayKey,
        perDay: rolledOver ? { tokens: 0, usd: 0 } : stored.perDay,
        perIssue: stored.perIssue,
      }
    },
    save(snapshot) {
      savedCalls.push(snapshot)
      stored = { version: 1, updatedAt: new Date().toISOString(), ...snapshot }
    },
    async flush() {
      flushCalls++
    },
  }
}

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

describe("BudgetService.ready — persistence hydration", () => {
  test("createNoopBudgetService().ready resolves immediately", async () => {
    await expect(readyOf(createNoopBudgetService())).resolves.toBeUndefined()
  })

  test("createInMemoryBudgetService without persistence resolves ready immediately", async () => {
    const svc = createInMemoryBudgetService({ caps: makeCaps() })
    await expect(readyOf(svc)).resolves.toBeUndefined()
  })

  test("hydrates perDay + perIssue counters from persistence on the same UTC day before ready resolves", async () => {
    const now = new Date("2026-07-16T10:00:00Z")
    const persistence = makeFakePersistence({
      dayKey: "2026-07-16",
      perDay: { tokens: 4_000, usd: 2 },
      perIssue: { i1: { tokens: 1_000, usd: 0.5 } },
    })
    const svc = createInMemoryBudgetService({ caps: makeCaps(), persistence, now: () => now })
    await readyOf(svc)

    expect(svc.getDailyUsed()).toEqual({ tokens: 4_000, usd: 2 })
    expect(svc.getIssueUsed("i1")).toEqual({ tokens: 1_000, usd: 0.5 })
  })

  test("rolls over: persisted counter from a prior UTC day is not hydrated into today's daily total", async () => {
    const now = new Date("2026-07-16T00:05:00Z")
    const persistence = makeFakePersistence({
      dayKey: "2026-07-15",
      perDay: { tokens: 9_000, usd: 9 },
      perIssue: { i1: { tokens: 500, usd: 0.25 } },
    })
    const svc = createInMemoryBudgetService({ caps: makeCaps(), persistence, now: () => now })
    await readyOf(svc)

    expect(svc.getDailyUsed()).toEqual({ tokens: 0, usd: 0 })
    // Per-issue totals are not date-scoped and survive rollover.
    expect(svc.getIssueUsed("i1")).toEqual({ tokens: 500, usd: 0.25 })
  })

  test("recordUsage() mirrors the new counters through the persistence port", async () => {
    const persistence = makeFakePersistence()
    const svc = createInMemoryBudgetService({ caps: makeCaps(), persistence })
    await readyOf(svc)

    await svc.recordUsage("att-1", "i1", { input: 100, output: 50, model: "claude-sonnet" })

    expect(persistence.savedCalls).toHaveLength(1)
    expect(persistence.savedCalls[0]).toMatchObject({
      perDay: { tokens: 150 },
      perIssue: { i1: { tokens: 150 } },
    })
  })

  test("a restarted service reloads yesterday's usage from disk for the same issue (crash-restart survival)", async () => {
    const dayOne = new Date("2026-07-16T12:00:00Z")
    const store = makeFakePersistence()

    const first = createInMemoryBudgetService({ caps: makeCaps(), persistence: store, now: () => dayOne })
    await readyOf(first)
    await first.recordUsage("a", "i1", { input: 600, output: 0, model: "claude-sonnet" })

    // Simulate a restart: a brand-new service instance backed by the same store.
    const second = createInMemoryBudgetService({ caps: makeCaps(), persistence: store, now: () => dayOne })
    await readyOf(second)

    expect(second.getIssueUsed("i1").tokens).toBe(600)
    expect(second.getDailyUsed().tokens).toBe(600)
  })

  test("checkBeforeSpawn awaits hydration — a spawn issued immediately after construction still respects a cap loaded from disk, not zeros", async () => {
    // A persistence port whose load() resolves on a later microtask/tick,
    // simulating disk I/O that hasn't completed by the time a caller
    // fires checkBeforeSpawn right after construction (the boot-window
    // race). Before the fix, checkBeforeSpawn read perIssue/perDay before
    // `ready` settled and saw the zeroed maps, so it would allow a spawn
    // that had already exhausted the persisted daily cap pre-restart.
    const persistence: BudgetUsagePort = {
      async load(currentDayKey) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return {
          version: 1,
          updatedAt: "",
          dayKey: currentDayKey,
          perDay: { tokens: 10_000, usd: 0 },
          perIssue: {},
        }
      },
      save() {},
      async flush() {},
    }
    const svc = createInMemoryBudgetService({
      caps: makeCaps({ perDay: { tokens: 10_000, usd: 0 } }),
      persistence,
    })

    // Fired immediately, before `ready` has resolved. Must still deny
    // because the persisted daily total already reached the cap — a
    // zeroed in-memory map would incorrectly allow it.
    const decision = await svc.checkBeforeSpawn(makeIssue({ id: "i1" }))
    expect(decision).toMatchObject({ allow: false, reason: "daily_cap", unit: "tokens", cap: 10_000 })
    expect(svc.getDailyUsed()).toEqual({ tokens: 10_000, usd: 0 })
  })

  test("recordUsage awaits hydration — usage recorded during the boot window is not clobbered once hydration resolves", async () => {
    const persistence: BudgetUsagePort = {
      async load(currentDayKey) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return {
          version: 1,
          updatedAt: "",
          dayKey: currentDayKey,
          perDay: { tokens: 1_000, usd: 0 },
          perIssue: { i1: { tokens: 1_000, usd: 0 } },
        }
      },
      save() {},
      async flush() {},
    }
    const svc = createInMemoryBudgetService({ caps: makeCaps(), persistence })

    // Fired immediately, before `ready` resolves.
    await svc.recordUsage("a", "i1", { input: 100, output: 0, model: "unknown-model" })

    // The persisted 1,000 baseline plus the 100 recorded during the boot
    // window must both be reflected — hydrate() must not have overwritten
    // the recordUsage() write once its own load() resolved afterward.
    expect(svc.getIssueUsed("i1").tokens).toBe(1_100)
    expect(svc.getDailyUsed().tokens).toBe(1_100)
  })
})

describe("BudgetService.flush — drain persisted-counter write queue on shutdown", () => {
  function flushOf(svc: BudgetService): () => Promise<void> {
    if (!svc.flush) throw new Error("expected BudgetService.flush to be defined on this implementation")
    return svc.flush.bind(svc)
  }

  test("createNoopBudgetService().flush() resolves immediately", async () => {
    await expect(flushOf(createNoopBudgetService())()).resolves.toBeUndefined()
  })

  test("createInMemoryBudgetService without persistence resolves flush() immediately", async () => {
    const svc = createInMemoryBudgetService({ caps: makeCaps() })
    await expect(flushOf(svc)()).resolves.toBeUndefined()
  })

  test("flush() awaits the underlying BudgetUsagePort.flush()", async () => {
    const persistence = makeFakePersistence()
    const svc = createInMemoryBudgetService({ caps: makeCaps(), persistence })
    await readyOf(svc)

    await flushOf(svc)()

    expect(persistence.flushCalls).toBe(1)
  })
})

describe("BudgetService.checkMidRun — streaming enforcement", () => {
  test("no-op service always allows", () => {
    expect(checkMidRunOf(createNoopBudgetService())("i1", 999_999)).toEqual({ allow: true })
  })

  test("allows while projected issue tokens stay under the per-issue cap", () => {
    const svc = createInMemoryBudgetService({ caps: makeCaps({ perIssue: { tokens: 1_000, usd: 0 } }) })
    expect(checkMidRunOf(svc)("i1", 500)).toEqual({ allow: true })
  })

  test("stops (allow: false) once projected issue tokens reach the per-issue cap", () => {
    const svc = createInMemoryBudgetService({ caps: makeCaps({ perIssue: { tokens: 1_000, usd: 0 } }) })
    const decision = checkMidRunOf(svc)("i1", 1_000)
    expect(decision).toMatchObject({ allow: false, reason: "issue_cap", unit: "tokens", cap: 1_000 })
  })

  test("accounts for already-recorded usage when projecting the per-issue cap", async () => {
    const svc = createInMemoryBudgetService({ caps: makeCaps({ perIssue: { tokens: 1_000, usd: 0 } }) })
    await svc.recordUsage("prev", "i1", { input: 700, output: 0, model: "unknown" })
    // 700 already recorded + 250 streamed so far = 950, still under 1000
    expect(checkMidRunOf(svc)("i1", 250)).toEqual({ allow: true })
    // 700 + 300 = 1000 >= cap -> stop
    expect(checkMidRunOf(svc)("i1", 300).allow).toBe(false)
  })

  test("stops when projected per-day tokens reach the daily cap even if the per-issue cap is not reached", () => {
    const svc = createInMemoryBudgetService({
      caps: makeCaps({ perIssue: { tokens: 100_000, usd: 0 }, perDay: { tokens: 2_000, usd: 0 } }),
    })
    const decision = checkMidRunOf(svc)("i1", 2_000)
    expect(decision).toMatchObject({ allow: false, reason: "daily_cap", unit: "tokens" })
  })

  test("warn mode still allows the run to continue past the mid-run cap", () => {
    const svc = createInMemoryBudgetService({
      caps: makeCaps({ perIssue: { tokens: 100, usd: 0 }, onExceed: "warn" }),
    })
    expect(checkMidRunOf(svc)("i1", 500)).toEqual({ allow: true })
  })

  test("a zero token cap (unset) never triggers a mid-run stop from the token check alone", () => {
    const svc = createInMemoryBudgetService({
      caps: makeCaps({ perIssue: { tokens: 0, usd: 5 }, perDay: { tokens: 0, usd: 5 } }),
    })
    expect(checkMidRunOf(svc)("i1", 1_000_000)).toEqual({ allow: true })
  })
})
