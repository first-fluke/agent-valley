import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { watchOrders } from "../chief-watch"
import { parseStaleDays, runStorageGc, summarizeStorageGc } from "../storage-gc-command"

let root: string | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe("av gc", () => {
  it("parses the retention period and explains invalid values", () => {
    expect(parseStaleDays(undefined)).toBe(7)
    expect(parseStaleDays("0")).toBe(0)
    expect(parseStaleDays("2.5")).toBe(2.5)
    expect(() => parseStaleDays("soon")).toThrow("--stale-days soon is invalid")
    expect(() => parseStaleDays("-3")).toThrow("non-negative number of days")
  })

  it("summarizes outcomes", () => {
    expect(
      summarizeStorageGc([
        { kind: "build-output", path: "/a", outcome: "released", reason: "" },
        { kind: "child-archive", path: "/b", outcome: "kept", reason: "" },
        { kind: "actor-workspace", path: "/c", outcome: "eligible", reason: "" },
        { kind: "actor-workspace", path: "/d", outcome: "eligible", reason: "" },
      ]),
    ).toBe("1 released, 2 eligible, 1 kept")
  })

  it("reports a dry run in a repository without AV storage", async () => {
    root = await mkdtemp(join(tmpdir(), "av-gc-empty-"))
    const lines: string[] = []
    expect(await runStorageGc({}, root, (line) => lines.push(line))).toEqual([])
    expect(lines.join("\n")).toContain("Storage GC (dry run, stale after 7 days): 0 released, 0 eligible, 0 kept.")
    expect(lines.join("\n")).toContain("Nothing was removed; run av gc --apply")
  })

  it("refuses to run inside an AV-managed Actor", async () => {
    vi.stubEnv("AGENT_VALLEY_MANAGED_RUN", "1")
    await expect(runStorageGc({}, tmpdir(), () => {})).rejects.toThrow("already managed by AV")
    vi.unstubAllEnvs()
  })
})

describe("watcher storage release", () => {
  it("applies storage GC at most once per interval and keeps watching when it fails", async () => {
    root = await mkdtemp(join(tmpdir(), "av-gc-watch-"))
    const controller = new AbortController()
    let clock = 0
    let ticks = 0
    const storageGc = vi
      .fn<(root: string, options: { apply: boolean }) => Promise<{ entries: { outcome: string }[] }>>()
      .mockRejectedValueOnce(new Error("disk busy"))
      .mockResolvedValue({ entries: [{ outcome: "released" }] })
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "log").mockImplementation(() => {})
    await watchOrders(root, {
      signal: controller.signal,
      storageGc,
      storageGcIntervalMs: 1_000,
      now: () => clock,
      delay: async () => {
        clock += 600
        if (++ticks === 4) controller.abort()
      },
    })
    // t=0 runs (fails), t=600 skips, t=1200 runs, t=1800 skips.
    expect(storageGc).toHaveBeenCalledTimes(2)
    expect(storageGc).toHaveBeenCalledWith(root, { apply: true })
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Storage GC failed"))
  })
})
