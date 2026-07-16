/**
 * RunStatePersistence tests — persist->reload round-trip + missing/corrupt file handling.
 * Uses a real /tmp file (matches dag-scheduler.test.ts convention) since this is the
 * one component whose job *is* the filesystem boundary.
 */

import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises"
import { afterEach, describe, expect, test, vi } from "vitest"
import { RunStatePersistence } from "../orchestrator/persistence/run-state-store"

// Wrap (not replace) the real fs implementations so every other test in
// this file still hits the real filesystem — only `rename`/`writeFile`
// call history is observable, and individual tests can override one call
// with `mockImplementationOnce` to simulate a mid-write crash.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) }
})

const TEST_STORE = `/tmp/run-state-test-${crypto.randomUUID()}.json`

afterEach(async () => {
  try {
    await unlink(TEST_STORE)
  } catch {
    /* already removed */
  }
  try {
    await unlink(`${TEST_STORE}.tmp`)
  } catch {
    /* already removed */
  }
})

describe("RunStatePersistence", () => {
  test("load() returns an empty snapshot when the file does not exist", async () => {
    const store = new RunStatePersistence(TEST_STORE)
    const snapshot = await store.load()
    expect(snapshot.activeAttempts).toEqual([])
    expect(snapshot.retryQueue).toEqual([])
  })

  test("load() returns an empty snapshot when the file is corrupt", async () => {
    await mkdir(TEST_STORE.replace(/\/[^/]+$/, ""), { recursive: true })
    await writeFile(TEST_STORE, "{ not valid json", "utf-8")
    const store = new RunStatePersistence(TEST_STORE)
    const snapshot = await store.load()
    expect(snapshot.activeAttempts).toEqual([])
    expect(snapshot.retryQueue).toEqual([])
  })

  test("persist -> reload round-trips activeAttempts and retryQueue", async () => {
    const writer = new RunStatePersistence(TEST_STORE)
    writer.replaceActiveAttempts([
      { issueId: "i1", attemptId: "a1", workspacePath: "/ws/i1", pid: null, startedAt: "2026-07-16T00:00:00.000Z" },
    ])
    writer.replaceRetryQueue([
      { issueId: "i2", attemptCount: 1, nextRetryAt: "2026-07-16T00:05:00.000Z", lastError: "boom" },
    ])
    await writer.flush()

    const reader = new RunStatePersistence(TEST_STORE)
    const snapshot = await reader.load()
    expect(snapshot.activeAttempts).toHaveLength(1)
    expect(snapshot.activeAttempts[0]).toMatchObject({ issueId: "i1", attemptId: "a1", workspacePath: "/ws/i1" })
    expect(snapshot.retryQueue).toHaveLength(1)
    expect(snapshot.retryQueue[0]).toMatchObject({ issueId: "i2", attemptCount: 1 })
  })

  test("later writes win — replaceActiveAttempts followed by an empty replace persists empty", async () => {
    const store = new RunStatePersistence(TEST_STORE)
    store.replaceActiveAttempts([
      { issueId: "i1", attemptId: "a1", workspacePath: "/ws/i1", pid: null, startedAt: "t" },
    ])
    store.replaceActiveAttempts([])
    await store.flush()

    const reader = new RunStatePersistence(TEST_STORE)
    const snapshot = await reader.load()
    expect(snapshot.activeAttempts).toEqual([])
  })

  test("retry entry category round-trips through persist -> reload", async () => {
    const writer = new RunStatePersistence(TEST_STORE)
    writer.replaceRetryQueue([
      {
        issueId: "i1",
        attemptCount: 1,
        nextRetryAt: "2026-07-16T00:05:00.000Z",
        lastError: "boom",
        category: "capability",
      },
    ])
    await writer.flush()

    const reader = new RunStatePersistence(TEST_STORE)
    const snapshot = await reader.load()
    expect(snapshot.retryQueue[0]?.category).toBe("capability")
  })

  test("a pre-classification snapshot on disk (no category key) defaults to 'infra' on load", async () => {
    await mkdir(TEST_STORE.replace(/\/[^/]+$/, ""), { recursive: true })
    await writeFile(
      TEST_STORE,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-07-01T00:00:00.000Z",
        activeAttempts: [],
        retryQueue: [{ issueId: "i1", attemptCount: 1, nextRetryAt: "2026-07-16T00:05:00.000Z", lastError: "boom" }],
      }),
      "utf-8",
    )

    const reader = new RunStatePersistence(TEST_STORE)
    const snapshot = await reader.load()
    expect(snapshot.retryQueue[0]?.category).toBe("infra")
  })

  test("saveSnapshot writes through a sibling .tmp file and atomically renames it into place", async () => {
    const store = new RunStatePersistence(TEST_STORE)
    store.replaceActiveAttempts([
      { issueId: "i1", attemptId: "a1", workspacePath: "/ws/i1", pid: null, startedAt: "t" },
    ])
    await store.flush()

    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(`${TEST_STORE}.tmp`, expect.any(String), "utf-8")
    expect(vi.mocked(rename)).toHaveBeenCalledWith(`${TEST_STORE}.tmp`, TEST_STORE)

    // No leftover temp file after a successful write — rename() consumed it.
    const dir = TEST_STORE.replace(/\/[^/]+$/, "")
    const tmpName = `${TEST_STORE.split("/").pop()}.tmp`
    const files = await readdir(dir)
    expect(files).not.toContain(tmpName)
  })

  test("a failed write to the .tmp file leaves an existing snapshot on disk untouched (no truncation)", async () => {
    const writer = new RunStatePersistence(TEST_STORE)
    writer.replaceActiveAttempts([
      { issueId: "before", attemptId: "a0", workspacePath: "/ws/before", pid: null, startedAt: "t0" },
    ])
    await writer.flush()

    // Simulate a crash mid-write: the .tmp write itself fails, so rename()
    // must never run and the previously-written storePath must be left
    // exactly as it was (never truncated in place).
    vi.mocked(writeFile).mockImplementationOnce(() => Promise.reject(new Error("simulated disk full")))
    writer.replaceActiveAttempts([
      { issueId: "after", attemptId: "a1", workspacePath: "/ws/after", pid: null, startedAt: "t1" },
    ])
    await writer.flush()

    const reader = new RunStatePersistence(TEST_STORE)
    const snapshot = await reader.load()
    expect(snapshot.activeAttempts).toHaveLength(1)
    expect(snapshot.activeAttempts[0]).toMatchObject({ issueId: "before", attemptId: "a0" })
  })
})
