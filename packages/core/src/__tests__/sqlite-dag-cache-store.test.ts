/**
 * SqliteDagCacheStore tests — DagScheduler persists its graph through the
 * state database, and a legacy dag-cache.json is imported once.
 */

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { DagScheduler } from "../orchestrator/dag-scheduler"
import { SqliteDagCacheStore } from "../state/sqlite-dag-cache-store"
import { StateDatabase } from "../state/state-database"
import { makeIssue } from "./characterization/helpers"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe("SqliteDagCacheStore", () => {
  test("is empty until a graph is saved", async () => {
    const db = StateDatabase.inMemory()
    expect(await new SqliteDagCacheStore(db).load()).toBeNull()
    await db.close()
  })

  test("round-trips the scheduler's graph, including relations", async () => {
    const db = StateDatabase.inMemory()
    const store = new SqliteDagCacheStore(db)
    const scheduler = new DagScheduler(store)
    scheduler.buildFromIssues([
      makeIssue({ id: "a", identifier: "PROJ-1" }),
      makeIssue({
        id: "b",
        identifier: "PROJ-2",
        parentId: "a",
        relations: [{ type: "blocked_by", relatedIssueId: "a", relatedIdentifier: "PROJ-1" }],
      }),
    ])
    scheduler.updateNodeStatus("a", "running")
    await scheduler.saveCache()

    const reloaded = new DagScheduler(store)
    await reloaded.loadCache()
    expect(reloaded.getNode("a")).toMatchObject({ identifier: "PROJ-1", status: "running", blocks: ["b"] })
    expect(reloaded.getNode("b")).toMatchObject({ parentId: "a", blockedBy: ["a"] })
    await db.close()
  })

  test("imports a legacy dag-cache.json once and renames it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-dag-cache-"))
    dirs.push(dir)
    const legacyPath = join(dir, "dag-cache.json")
    const node = {
      issueId: "a",
      identifier: "PROJ-1",
      status: "waiting",
      parentId: null,
      children: [],
      blockedBy: [],
      blocks: [],
    }
    await writeFile(
      legacyPath,
      JSON.stringify({ version: 1, updatedAt: "2026-11-02T00:00:00.000Z", nodes: { a: node } }),
    )
    const db = StateDatabase.inMemory()

    const cache = await new SqliteDagCacheStore(db, legacyPath).load()
    expect(cache?.nodes).toEqual({ a: node })
    expect(cache?.updatedAt).toBe("2026-11-02T00:00:00.000Z")
    expect(await readdir(dir)).toEqual(["dag-cache.json.migrated"])
    await db.close()
  })
})
