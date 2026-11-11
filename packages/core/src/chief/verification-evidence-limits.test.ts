import { describe, expect, it } from "vitest"
import { goalVerificationResultSchema } from "./verification"

const digest = "a".repeat(64)
const check = { checkSha256: digest, kind: "command" as const, passed: true, summary: "ran", exitCode: 0 }

describe("goal verification evidence limits", () => {
  it("accepts as many evidence checks per criterion as the contract allows", () => {
    const result = {
      ok: true,
      output: "",
      contractSha256: digest,
      checkedAt: new Date("2026-11-10T00:00:00Z").toISOString(),
      evidence: [{ criterion: "all gates pass", passed: true, checks: Array.from({ length: 20 }, () => check) }],
    }
    expect(goalVerificationResultSchema.safeParse(result).success).toBe(true)
    const tooMany = {
      ...result,
      evidence: [{ ...result.evidence[0], checks: Array.from({ length: 21 }, () => check) }],
    }
    expect(goalVerificationResultSchema.safeParse(tooMany).success).toBe(false)
  })
})
