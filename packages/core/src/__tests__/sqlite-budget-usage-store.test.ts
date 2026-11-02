/**
 * SqliteBudgetUsageStore tests — counters round-trip through the state
 * database, roll over by UTC day, and import a legacy budget-usage.json.
 */

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { SqliteBudgetUsageStore } from "../state/sqlite-budget-usage-store"
import { StateDatabase } from "../state/state-database"

const SNAPSHOT = {
  dayKey: "2026-11-02",
  perDay: { tokens: 1200, usd: 0.75 },
  perIssue: { i1: { tokens: 700, usd: 0.5 }, i2: { tokens: 500, usd: 0.25 } },
  recordedAttemptIds: ["a1", "a2"],
}

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe("SqliteBudgetUsageStore", () => {
  test("starts from zero", async () => {
    const db = StateDatabase.inMemory()
    expect(await new SqliteBudgetUsageStore(db).load("2026-11-02")).toMatchObject({
      dayKey: "2026-11-02",
      perDay: { tokens: 0, usd: 0 },
      perIssue: {},
      recordedAttemptIds: [],
    })
    await db.close()
  })

  test("round-trips counters for the same day and resets the day counter after rollover", async () => {
    const db = StateDatabase.inMemory()
    const store = new SqliteBudgetUsageStore(db)
    store.save({ ...SNAPSHOT, perDay: { tokens: 1, usd: 0.01 } })
    store.save(SNAPSHOT)
    await store.flush()

    expect(await new SqliteBudgetUsageStore(db).load("2026-11-02")).toMatchObject(SNAPSHOT)
    expect(await new SqliteBudgetUsageStore(db).load("2026-11-03")).toMatchObject({
      dayKey: "2026-11-03",
      perDay: { tokens: 0, usd: 0 },
      perIssue: SNAPSHOT.perIssue,
      recordedAttemptIds: SNAPSHOT.recordedAttemptIds,
    })
    await db.close()
  })

  test("imports a legacy budget-usage.json once and renames it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-budget-usage-"))
    dirs.push(dir)
    const legacyPath = join(dir, "budget-usage.json")
    await writeFile(legacyPath, JSON.stringify({ version: 1, updatedAt: "x", ...SNAPSHOT }))
    const db = StateDatabase.inMemory()

    expect(await new SqliteBudgetUsageStore(db, legacyPath).load("2026-11-02")).toMatchObject(SNAPSHOT)
    expect(await readdir(dir)).toEqual(["budget-usage.json.migrated"])
    await db.close()
  })
})
