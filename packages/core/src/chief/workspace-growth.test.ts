import { describe, expect, it } from "vitest"
import { growthReport, growthThresholdBytes, STORAGE_NOTE_PREFIX } from "./workspace-growth"

const GIB = 1024 ** 3
const sizes = (entries: Record<string, number>) => new Map(Object.entries(entries).map(([k, v]) => [k, v * GIB]))

describe("integration check storage growth", () => {
  it("reports the directories a check filled, deepest first, and ignores AV's own storage", () => {
    const before = sizes({ "": 20, target: 10, "target/debug": 9, ".agent-valley": 8, ".git": 1 })
    const after = sizes({
      "": 31,
      target: 12.7,
      "target/debug": 9.1,
      "target/fixtures": 2.6,
      "target/fixtures/native": 2.5,
      ".agent-valley": 16,
      ".git": 1.3,
    })
    const report = growthReport(before, after, GIB)
    expect(report?.startsWith(STORAGE_NOTE_PREFIX)).toBe(true)
    expect(report).toContain("left 2.7 GiB of new files")
    expect(report).toContain("mostly under target/fixtures/native (+2.5 GiB)")
    expect(report).not.toContain(".agent-valley")
    expect(report).not.toContain("target (+")
  })

  it("stays silent below the threshold, when sizes are unknown, or when the report is disabled", () => {
    const before = sizes({ "": 20, target: 10 })
    const after = sizes({ "": 20.5, target: 10.5 })
    expect(growthReport(before, after, GIB)).toBeUndefined()
    expect(growthReport(undefined, after, GIB)).toBeUndefined()
    expect(growthReport(before, sizes({ "": 30, target: 20 }), 0)).toBeUndefined()
  })

  it("reads the threshold from the environment and rejects an invalid value", () => {
    expect(growthThresholdBytes({})).toBe(GIB)
    expect(growthThresholdBytes({ AV_INTEGRATION_CHECK_GROWTH_GIB: "0" })).toBe(0)
    expect(growthThresholdBytes({ AV_INTEGRATION_CHECK_GROWTH_GIB: "2.5" })).toBe(2.5 * GIB)
    expect(() => growthThresholdBytes({ AV_INTEGRATION_CHECK_GROWTH_GIB: "many" })).toThrow("non-negative")
  })
})
