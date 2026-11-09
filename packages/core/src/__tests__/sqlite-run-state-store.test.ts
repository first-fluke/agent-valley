/**
 * SqliteRunStateStore tests — round-trip through the state database and the
 * one-time import of a legacy run-state.json.
 */

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import type { DeadLetterEntry, Workspace } from "../domain/models"
import type {
  PersistedAttempt,
  PersistedFinalization,
  PersistedRetryEntry,
} from "../orchestrator/persistence/run-state-store"
import { SqliteRunStateStore } from "../state/sqlite-run-state-store"
import { StateDatabase } from "../state/state-database"

const ATTEMPT: PersistedAttempt = {
  issueId: "i1",
  attemptId: "a1",
  workspacePath: "/ws/i1",
  pid: 4242,
  startedAt: "2026-11-02T00:00:00.000Z",
}
const RETRY: PersistedRetryEntry = {
  issueId: "i2",
  attemptCount: 1,
  nextRetryAt: "2026-11-02T00:05:00.000Z",
  lastError: "tests failed",
  category: "verification",
}
const DEAD_LETTER: DeadLetterEntry = {
  issueId: "i-dl",
  attemptCount: 3,
  failedAt: "2026-11-02T01:00:00.000Z",
  lastError: "unrecoverable failure",
  category: "capability",
}
const WORKSPACE: Workspace = {
  issueId: "i3",
  path: "/ws/i3",
  key: "PROJ-3",
  branch: "feature/PROJ-3",
  status: "idle",
  createdAt: "2026-11-02T00:00:00.000Z",
}
const FINALIZATION: PersistedFinalization = {
  phase: "pending",
  issueId: "i3",
  issueKey: "PROJ-3",
  parentId: null,
  attemptId: "a3",
  agentType: "claude",
  workspace: WORKSPACE,
  deliveryMode: "pr",
  hasCodeChanges: true,
  autoCommitted: false,
  durationMs: 1200,
}

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe("SqliteRunStateStore", () => {
  test("round-trips attempts, retries, dead letters and finalizations through the database", async () => {
    const db = StateDatabase.inMemory()
    const writer = new SqliteRunStateStore(db)
    writer.replaceActiveAttempts([ATTEMPT, { ...ATTEMPT, issueId: "i9", attemptId: "a9", pid: null }])
    writer.replaceRetryQueue([RETRY], [DEAD_LETTER])
    writer.replacePendingFinalizations([FINALIZATION])
    await writer.flushOrThrow()

    const snapshot = await new SqliteRunStateStore(db).load()
    expect(snapshot.activeAttempts).toEqual([ATTEMPT, { ...ATTEMPT, issueId: "i9", attemptId: "a9", pid: null }])
    expect(snapshot.retryQueue).toEqual([RETRY])
    expect(snapshot.deadLetterQueue).toEqual([DEAD_LETTER])
    expect(snapshot.pendingFinalizations).toEqual([FINALIZATION])
    expect(snapshot.updatedAt).not.toBe("")
    await db.close()
  })

  test("each replace overwrites its table only and defaults a missing retry category", async () => {
    const db = StateDatabase.inMemory()
    const store = new SqliteRunStateStore(db)
    store.replaceActiveAttempts([ATTEMPT])
    store.replaceRetryQueue([{ ...RETRY, category: undefined }])
    store.replaceRetryQueue([])
    store.replaceRetryQueue([{ ...RETRY, category: undefined }])
    store.replaceDeadLetterQueue([DEAD_LETTER])
    await store.flushOrThrow()

    const snapshot = await new SqliteRunStateStore(db).load()
    expect(snapshot.activeAttempts).toEqual([ATTEMPT])
    expect(snapshot.retryQueue).toEqual([{ ...RETRY, category: "infra" }])
    expect(snapshot.deadLetterQueue).toEqual([DEAD_LETTER])
    await db.close()
  })

  test("imports a legacy run-state.json once and renames it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-run-state-"))
    dirs.push(dir)
    const legacyPath = join(dir, "run-state.json")
    await writeFile(
      legacyPath,
      JSON.stringify({
        version: 1,
        updatedAt: "x",
        activeAttempts: [ATTEMPT],
        retryQueue: [RETRY],
        deadLetterQueue: [DEAD_LETTER],
      }),
    )
    const db = StateDatabase.inMemory()

    const snapshot = await new SqliteRunStateStore(db, legacyPath).load()
    expect(snapshot.activeAttempts).toEqual([ATTEMPT])
    expect(snapshot.retryQueue).toEqual([RETRY])
    expect(snapshot.deadLetterQueue).toEqual([DEAD_LETTER])
    expect(await readdir(dir)).toEqual(["run-state.json.migrated"])

    // A file that reappears later is left alone.
    await writeFile(legacyPath, JSON.stringify({ version: 1, activeAttempts: [{ ...ATTEMPT, issueId: "stale" }] }))
    const again = await new SqliteRunStateStore(db, legacyPath).load()
    expect(again.activeAttempts).toEqual([ATTEMPT])
    expect((await readdir(dir)).sort()).toEqual(["run-state.json", "run-state.json.migrated"])
    await db.close()
  })

  test("surfaces a failed write through flushOrThrow", async () => {
    const db = StateDatabase.inMemory()
    await db.close()
    const store = new SqliteRunStateStore(db)
    store.replaceActiveAttempts([ATTEMPT])
    await expect(store.flushOrThrow()).rejects.toThrow()
  })
})
