/**
 * openStateStores tests — one state.db under `.agent-valley`, legacy JSON
 * snapshots imported on first open.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { openStateStores } from "../state/open-state-stores"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe("openStateStores", () => {
  test("creates state.db, imports legacy snapshots and keeps state across reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "av-state-"))
    dirs.push(root)
    const stateDir = join(root, ".agent-valley")
    await mkdir(stateDir, { recursive: true })
    await writeFile(
      join(stateDir, "run-state.json"),
      JSON.stringify({
        version: 1,
        activeAttempts: [],
        retryQueue: [{ issueId: "i1", attemptCount: 1, nextRetryAt: "2026-11-02T00:00:00.000Z", lastError: "flaky" }],
      }),
    )

    const first = await openStateStores(stateDir)
    const snapshot = await first.runState.load()
    expect(snapshot.retryQueue).toEqual([
      {
        issueId: "i1",
        attemptCount: 1,
        nextRetryAt: "2026-11-02T00:00:00.000Z",
        lastError: "flaky",
        category: "infra",
      },
    ])
    expect(first.dedupCache.checkAndRecord("delivery:1")).toBe(true)
    first.runState.replaceRetryQueue([])
    await first.close()

    const files = await readdir(stateDir)
    expect(files).toContain("state.db")
    expect(files).toContain("run-state.json.migrated")

    const second = await openStateStores(stateDir)
    expect((await second.runState.load()).retryQueue).toEqual([])
    expect(second.dedupCache.checkAndRecord("delivery:1")).toBe(false)
    await second.close()
  })
})
