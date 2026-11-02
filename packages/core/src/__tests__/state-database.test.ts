/**
 * StateDatabase tests — schema setup, transactional writes and shutdown on
 * an in-memory libsql database.
 */

import { describe, expect, test } from "vitest"
import { StateDatabase } from "../state/state-database"

describe("StateDatabase", () => {
  test("creates the schema, records its version and tolerates a second setup", async () => {
    const db = StateDatabase.inMemory()
    expect(await db.getMeta("schema_version")).toBe("1")

    const again = new StateDatabase(db.client)
    await expect(again.ready).resolves.toBeUndefined()
    await db.close()
  })

  test("write() applies all statements or none", async () => {
    const db = StateDatabase.inMemory()
    await expect(
      db.write([db.setMetaStatement("partial", "1"), { sql: "INSERT INTO no_such_table (x) VALUES (1)", args: [] }]),
    ).rejects.toThrow()
    expect(await db.getMeta("partial")).toBeNull()
    await db.close()
  })

  test("close() waits for issued writes and can be called twice", async () => {
    const db = StateDatabase.inMemory()
    const pending = db.write([db.setMetaStatement("k", "v")])
    await db.close()
    await expect(pending).resolves.toBeUndefined()
    await db.close()
  })
})
