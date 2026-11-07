import { describe, expect, it } from "vitest"
import { parseContinuousDecision } from "./continuous-contract"

describe("continuous Chief response parsing", () => {
  it.each([
    (json: string) => `The next decision follows.\n${json}\nThe recorded evidence supports it.`,
    (json: string) => `The next decision follows.\n\`\`\`json\n${json}\n\`\`\`\nEnd of decision.`,
  ])("accepts one strict decision object surrounded by native narration", (wrap) => {
    const decision = { action: "wait", reason: 'Source {window} still needs a "fresh" observation.' }
    expect(parseContinuousDecision(wrap(JSON.stringify(decision)))).toEqual(decision)
  })

  it("preserves the existing decision allowance above the planning response limit", () => {
    const decision = {
      action: "execute",
      goal: "Implement the next verified task.",
      reason: "The saved source windows establish this next task.",
      evidence: Array.from({ length: 40 }, (_, index) => `source/window-${index}: ${"x".repeat(3_900)}`),
    }
    const source = `The next decision follows.\n${JSON.stringify(decision)}\nEnd of decision.`
    expect(source.length).toBeGreaterThan(128_000)
    expect(source.length).toBeLessThan(256_000)
    expect(parseContinuousDecision(source)).toEqual(decision)
  })

  it.each([
    (json: string) => `${json}\n${json}`,
    (json: string) => `${json}\n{"unfinished":`,
    (json: string) => `Decision:\n${json.slice(0, -1)},}\nEnd.`,
    (json: string) => `Decision:\n[${json}]\nEnd.`,
  ])("keeps ambiguous, incomplete, malformed or non-object decisions invalid", (wrap) => {
    expect(() => parseContinuousDecision(wrap('{"action":"wait","reason":"Awaiting source"}'))).toThrow(
      "Invalid Chief decision",
    )
  })

  it("retains strict decision fields and the original source limit", () => {
    expect(() =>
      parseContinuousDecision('Decision:\n{"action":"wait","reason":"Awaiting source","run":"command"}'),
    ).toThrow("Invalid Chief decision")
    expect(() => parseContinuousDecision(" ".repeat(256_001))).toThrow("Invalid Chief decision")
  })
})
