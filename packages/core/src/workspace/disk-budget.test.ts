import { tmpdir } from "node:os"
import { describe, expect, it, vi } from "vitest"
import {
  DEFAULT_MIN_FREE_DISK_GIB,
  DiskBudgetExceeded,
  ensureDiskBudget,
  freeDiskBytes,
  minimumFreeDiskBytes,
} from "./disk-budget"

const GIB = 1024 ** 3
const impossible = { AV_MIN_FREE_DISK_GIB: String(1024 ** 3) }

describe("free disk budget", () => {
  it("defaults the minimum and reads AV_MIN_FREE_DISK_GIB", () => {
    expect(minimumFreeDiskBytes({})).toBe(DEFAULT_MIN_FREE_DISK_GIB * GIB)
    expect(minimumFreeDiskBytes({ AV_MIN_FREE_DISK_GIB: "2.5" })).toBe(2.5 * GIB)
    expect(minimumFreeDiskBytes({ AV_MIN_FREE_DISK_GIB: "0" })).toBe(0)
  })

  it("rejects an invalid minimum with the variable name and fix", () => {
    expect(() => minimumFreeDiskBytes({ AV_MIN_FREE_DISK_GIB: "lots" })).toThrow(
      /AV_MIN_FREE_DISK_GIB=lots is invalid.*non-negative number of GiB/,
    )
    expect(() => minimumFreeDiskBytes({ AV_MIN_FREE_DISK_GIB: "-1" })).toThrow("non-negative")
  })

  it("measures free space on the volume holding a path", async () => {
    const free = await freeDiskBytes(tmpdir())
    if (free !== undefined) expect(free).toBeGreaterThan(0)
  })

  it("does nothing when disabled or when enough space is free", async () => {
    const reclaim = vi.fn(async () => {})
    await ensureDiskBudget(tmpdir(), "a test clone", reclaim, { AV_MIN_FREE_DISK_GIB: "0" })
    await ensureDiskBudget(tmpdir(), "a test clone", reclaim, { AV_MIN_FREE_DISK_GIB: "0.000001" })
    expect(reclaim).not.toHaveBeenCalled()
  })

  it("reclaims AV storage once, then refuses with an actionable error when space is still short", async () => {
    if ((await freeDiskBytes(tmpdir())) === undefined) return
    const reclaim = vi.fn(async () => {})
    const refusal = ensureDiskBudget(tmpdir(), "a test clone", reclaim, impossible)
    await expect(refusal).rejects.toBeInstanceOf(DiskBudgetExceeded)
    await expect(ensureDiskBudget(tmpdir(), "a test clone", undefined, impossible)).rejects.toThrow(
      /before creating a test clone\. Run `av gc --apply`.*AV_MIN_FREE_DISK_GIB/,
    )
    expect(reclaim).toHaveBeenCalledOnce()
  })
})
