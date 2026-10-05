import { lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Operation } from "./continuous-contract"
import { ContinuousOperationStore } from "./continuous-store"

let directory: string
const record = (): Operation => ({
  id: "operation",
  repositoryRoot: "/repo",
  charter: "Improve the service",
  settings: { model: "pinned", oma: true },
  phase: "deciding",
  createdAt: "2026-10-05T00:00:00.000Z",
  updatedAt: "2026-10-05T00:00:00.000Z",
  completedCycles: 0,
  waitIntervalSec: 300,
  history: [],
})
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "av-continuous-store-")))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe("durable continuous operation storage", () => {
  it("writes private atomic records and snapshots queued mutable records at save time", async () => {
    const store = new ContinuousOperationStore(join(directory, "operations"))
    const value = record()
    const saving = store.save(value)
    value.charter = "Later mutation"
    await saving
    expect((await store.load(value.id)).charter).toBe("Improve the service")
    expect((await lstat(join(directory, "operations", "operation.json"))).mode & 0o777).toBe(0o600)
    expect((await lstat(join(directory, "operations"))).mode & 0o777).toBe(0o700)
    expect(await store.list()).toHaveLength(1)
  })

  it("serializes writes and excludes snapshot subdirectories from listings", async () => {
    const store = new ContinuousOperationStore(join(directory, "operations"))
    const value = record()
    const first = store.save(value)
    value.completedCycles = 1
    await Promise.all([first, store.save(value)])
    expect((await store.load(value.id)).completedCycles).toBe(1)
    expect(await new ContinuousOperationStore(join(directory, "missing")).list()).toEqual([])
  })

  it("shares the existing exclusive stale-owner-safe lease implementation", async () => {
    const store = new ContinuousOperationStore(join(directory, "operations"))
    const unlock = await store.lock("operation")
    await expect(new ContinuousOperationStore(join(directory, "operations")).lock("operation")).rejects.toThrow(
      "already running",
    )
    await unlock()
    await (await store.lock("operation"))()
  })

  it("rejects mismatched IDs, record versions and unsupported settings", async () => {
    const store = new ContinuousOperationStore(join(directory, "operations"))
    await store.save(record())
    const path = join(directory, "operations", "operation.json")
    await writeFile(path, JSON.stringify({ version: 2, operation: record() }))
    await expect(store.load("operation")).rejects.toThrow("Unsupported")
    await writeFile(path, JSON.stringify({ version: 1, operation: { ...record(), id: "foreign" } }))
    await expect(store.load("operation")).rejects.toThrow("filename")
    expect(() => store.save({ ...record(), settings: { secretObject: {} } } as unknown as Operation)).toThrow()
    await expect(store.load("../outside")).rejects.toThrow()
  })

  it("rejects redirected storage and symbolic record files without exposing their contents", async () => {
    const store = new ContinuousOperationStore(join(directory, "operations"))
    await store.save(record())
    const source = join(directory, "operations", "operation.json")
    const copy = join(directory, "outside.json")
    await writeFile(copy, await readFile(source))
    await rm(source)
    await symlink(copy, source)
    await expect(store.load("operation")).rejects.toThrow("regular file")
    await symlink(join(directory, "operations"), join(directory, "redirected"))
    await expect(new ContinuousOperationStore(join(directory, "redirected")).save(record())).rejects.toThrow("symlink")
  })
})
