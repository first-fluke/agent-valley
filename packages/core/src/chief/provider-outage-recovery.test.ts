import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { coordinate } from "./coordinator"
import { executionPolicySchema } from "./execution"
import { fixture } from "./goal-supervision.fixture"

const now = Date.parse("2026-10-03T10:00:00Z")
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
})
afterEach(() => {
  vi.useRealTimers()
})
const stages = (runAgent: ReturnType<typeof fixture>["runAgent"], stage: string) =>
  runAgent.mock.calls.filter((call) => call[3] === stage)

describe("an unreachable provider is waited out, not handed to the Chief", () => {
  it("returns the recovery round when the Chief itself is unreachable and keeps the request for the retry", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({})
    const base = value.runAgent.getMockImplementation()
    if (!base) throw new Error("Expected fixture Actor implementation")
    value.runAgent.mockImplementation(async (actor, prompt, mission, stage, context) => {
      if (stage === "work") throw new Error("Actual acceptance assertion failed")
      if (stage === "supervise") throw new Error("other: workspace routing discovery failed")
      return base(actor, prompt, mission, stage, context)
    })
    expect((await coordinate(value.mission, value.ports)).status).toBe("waiting")
    expect(value.mission.supervision).toMatchObject({ rounds: 0, stalledRounds: 0 })
    expect(value.mission.supervision?.pendingRecovery?.reason).toContain("acceptance assertion")
    expect(value.mission.execution).toMatchObject({
      failureKind: "provider",
      nextRunAt: new Date(now + 180_000).toISOString(),
    })
    expect(stages(value.runAgent, "supervise")).toHaveLength(1)
  })

  it("waits out an unreachable provider during work without asking the Chief", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({ maxRetries: 0 })
    const base = value.runAgent.getMockImplementation()
    if (!base) throw new Error("Expected fixture Actor implementation")
    value.runAgent.mockImplementation(async (actor, prompt, mission, stage, context) => {
      if (stage === "work") throw new Error("other: workspace routing discovery failed")
      return base(actor, prompt, mission, stage, context)
    })
    expect((await coordinate(value.mission, value.ports)).status).toBe("waiting")
    expect(stages(value.runAgent, "supervise")).toHaveLength(0)
    expect(value.mission.supervision).toMatchObject({ rounds: 0, stalledRounds: 0 })
    expect(value.mission.supervision?.pendingRecovery).toBeUndefined()
    expect(value.mission.execution?.retries ?? 0).toBe(0)
  })
})
