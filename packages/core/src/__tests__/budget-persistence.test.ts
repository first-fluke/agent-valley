/**
 * BudgetUsagePersistence tests — persist->reload round-trip + UTC-date
 * rollover + missing/corrupt file handling. Uses a real /tmp file
 * (matches persistence-run-state-store.test.ts / dag-scheduler.test.ts
 * convention) since this component's job *is* the filesystem boundary.
 */

import { mkdir, unlink, writeFile } from "node:fs/promises"
import { afterEach, describe, expect, test } from "vitest"
import { BudgetUsagePersistence } from "../orchestrator/budget-persistence"

const TEST_STORE = `/tmp/budget-usage-test-${crypto.randomUUID()}.json`

afterEach(async () => {
  try {
    await unlink(TEST_STORE)
  } catch {
    /* already removed */
  }
})

describe("BudgetUsagePersistence", () => {
  test("load() returns an empty snapshot when the file does not exist", async () => {
    const store = new BudgetUsagePersistence(TEST_STORE)
    const snapshot = await store.load("2026-07-16")
    expect(snapshot.perDay).toEqual({ tokens: 0, usd: 0 })
    expect(snapshot.perIssue).toEqual({})
    expect(snapshot.dayKey).toBe("2026-07-16")
  })

  test("load() returns an empty snapshot when the file is corrupt", async () => {
    await mkdir(TEST_STORE.replace(/\/[^/]+$/, ""), { recursive: true })
    await writeFile(TEST_STORE, "{ not valid json", "utf-8")
    const store = new BudgetUsagePersistence(TEST_STORE)
    const snapshot = await store.load("2026-07-16")
    expect(snapshot.perDay).toEqual({ tokens: 0, usd: 0 })
    expect(snapshot.perIssue).toEqual({})
  })

  test("persist -> reload round-trips perDay and perIssue counters for the same day", async () => {
    const writer = new BudgetUsagePersistence(TEST_STORE)
    writer.save({
      dayKey: "2026-07-16",
      perDay: { tokens: 5_000, usd: 1.25 },
      perIssue: { i1: { tokens: 3_000, usd: 0.75 }, i2: { tokens: 2_000, usd: 0.5 } },
    })
    await writer.flush()

    const reader = new BudgetUsagePersistence(TEST_STORE)
    const snapshot = await reader.load("2026-07-16")
    expect(snapshot.perDay).toEqual({ tokens: 5_000, usd: 1.25 })
    expect(snapshot.perIssue).toEqual({ i1: { tokens: 3_000, usd: 0.75 }, i2: { tokens: 2_000, usd: 0.5 } })
  })

  test("rolls over: a persisted counter from a prior UTC day is not reused for today", async () => {
    const writer = new BudgetUsagePersistence(TEST_STORE)
    writer.save({
      dayKey: "2026-07-15",
      perDay: { tokens: 9_999, usd: 9.99 },
      perIssue: { i1: { tokens: 100, usd: 0.1 } },
    })
    await writer.flush()

    const reader = new BudgetUsagePersistence(TEST_STORE)
    const snapshot = await reader.load("2026-07-16")
    // Daily counter resets on rollover...
    expect(snapshot.perDay).toEqual({ tokens: 0, usd: 0 })
    expect(snapshot.dayKey).toBe("2026-07-16")
    // ...but per-issue totals are not date-scoped and survive rollover.
    expect(snapshot.perIssue).toEqual({ i1: { tokens: 100, usd: 0.1 } })
  })

  test("later writes win — save() followed by a zeroed save() persists zero", async () => {
    const store = new BudgetUsagePersistence(TEST_STORE)
    store.save({ dayKey: "2026-07-16", perDay: { tokens: 500, usd: 1 }, perIssue: {} })
    store.save({ dayKey: "2026-07-16", perDay: { tokens: 0, usd: 0 }, perIssue: {} })
    await store.flush()

    const reader = new BudgetUsagePersistence(TEST_STORE)
    const snapshot = await reader.load("2026-07-16")
    expect(snapshot.perDay).toEqual({ tokens: 0, usd: 0 })
  })
})
