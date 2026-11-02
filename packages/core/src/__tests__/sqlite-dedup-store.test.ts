/**
 * Durable webhook dedup — keys recorded through WebhookDedupCache survive a
 * "restart" (a fresh cache hydrated from the same store).
 */

import { describe, expect, test } from "vitest"
import { SqliteDedupStore } from "../state/sqlite-dedup-store"
import { StateDatabase } from "../state/state-database"
import { WebhookDedupCache } from "../tracker/dedup-cache"

describe("WebhookDedupCache with SqliteDedupStore", () => {
  test("rejects a delivery replayed after a restart", async () => {
    const db = StateDatabase.inMemory()
    const store = new SqliteDedupStore(db)
    const now = 1_700_000_000_000

    const before = new WebhookDedupCache({ store, ttlMs: 60_000 })
    expect(before.checkAndRecord("delivery:1", now)).toBe(true)
    expect(before.checkAndRecord("delivery:2", now + 1)).toBe(true)
    await db.idle() // the inserts are fire-and-forget

    const after = new WebhookDedupCache({ store, ttlMs: 60_000 })
    await after.hydrate(now + 10)
    expect(after.checkAndRecord("delivery:1", now + 10)).toBe(false)
    expect(after.checkAndRecord("delivery:3", now + 10)).toBe(true)
    await db.close()
  })

  test("drops expired keys on hydrate and purges them from the store", async () => {
    const db = StateDatabase.inMemory()
    const store = new SqliteDedupStore(db)
    const now = 1_700_000_000_000

    const before = new WebhookDedupCache({ store, ttlMs: 1_000 })
    before.checkAndRecord("old", now)
    before.checkAndRecord("fresh", now + 900)
    await db.idle()

    const after = new WebhookDedupCache({ store, ttlMs: 1_000 })
    await after.hydrate(now + 1_500)
    await db.idle()
    expect(after.size).toBe(1)
    expect(after.checkAndRecord("old", now + 1_500)).toBe(true)
    await db.idle()
    const rows = await db.execute({ sql: "SELECT key FROM webhook_deliveries ORDER BY key", args: [] })
    expect(rows.rows.map((row) => row.key)).toEqual(["fresh", "old"])
    await db.close()
  })

  test("stays bounded by maxSize when hydrating", async () => {
    const db = StateDatabase.inMemory()
    const store = new SqliteDedupStore(db)
    const now = 1_700_000_000_000
    const before = new WebhookDedupCache({ store })
    for (let i = 0; i < 5; i++) before.checkAndRecord(`k${i}`, now + i)
    await db.idle()

    const after = new WebhookDedupCache({ store, maxSize: 3 })
    await after.hydrate(now + 10)
    expect(after.size).toBe(3)
    await db.close()
  })
})
