import { describe, expect, it } from "vitest"
import { coordinate } from "./coordinator"
import { executionPolicySchema } from "./execution"
import { fixture } from "./goal-supervision.fixture"
import { validateMission } from "./schemas"

describe("bounded initial plan format recovery", () => {
  it("corrects malformed plan JSON once with the pinned Chief and accounts for both calls", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({ maxRuns: 20, maxDurationSec: 60 })
    const original = value.runAgent.getMockImplementation()
    if (!original) throw new Error("Expected the fixture Actor implementation")
    let plans = 0
    value.runAgent.mockImplementation(async (...args) => {
      if (args[3] === "plan" && ++plans === 1) return "{invalid plan JSON"
      if (args[3] === "plan") {
        expect(args[1]).toContain("not valid JSON")
        expect(value.snapshots.some((snapshot) => JSON.stringify(snapshot.history).includes("not valid JSON"))).toBe(
          true,
        )
        expect(value.runAgent.mock.calls.some((call) => call[3] === "work")).toBe(false)
      }
      return original(...args)
    })

    await coordinate(value.mission, value.ports)

    expect(value.mission.status).toBe("completed")
    expect(value.runAgent.mock.calls.filter((call) => call[3] === "plan").map((call) => call[0])).toEqual([
      expect.objectContaining({ id: "chief", agentType: "codex", model: "operator-model" }),
      expect.objectContaining({ id: "chief", agentType: "codex", model: "operator-model" }),
    ])
    expect(value.mission.execution?.runsStarted).toBe(value.runAgent.mock.calls.length)
    expect(value.mission.supervision?.pendingRecovery).toBeUndefined()
    expect(value.runAgent.mock.calls.filter((call) => call[3] === "supervise")).toHaveLength(0)
    expect(value.verify).toHaveBeenCalledOnce()
    expect(value.mission.finalReview?.passed).toBe(true)
  })

  it("retains two invalid plan attempts and never resets that format limit on resume", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({ maxRuns: 20, maxDurationSec: 60 })
    const original = value.runAgent.getMockImplementation()
    if (!original) throw new Error("Expected the fixture Actor implementation")
    value.runAgent.mockImplementation(async (...args) =>
      args[3] === "plan" ? "{still invalid plan JSON" : original(...args),
    )

    await expect(coordinate(value.mission, value.ports)).rejects.toThrow()

    expect(value.runAgent.mock.calls.filter((call) => call[3] === "plan")).toHaveLength(2)
    expect(value.mission.status).toBe("failed")
    expect(value.mission.error).toBeTruthy()
    expect(value.mission.report?.summary).toContain("미완료")
    expect(value.mission.plan).toBeUndefined()
    expect(value.mission.tasks).toEqual([])
    expect(value.mission.supervision?.pendingRecovery).toBeUndefined()
    expect(value.verify).not.toHaveBeenCalled()
    const resumed = validateMission(structuredClone(value.mission))

    await expect(coordinate(resumed, value.ports)).rejects.toThrow()

    expect(value.runAgent.mock.calls.filter((call) => call[3] === "plan")).toHaveLength(2)
    expect(resumed.plan).toBeUndefined()
    expect(resumed.execution?.runsStarted).toBe(value.runAgent.mock.calls.length)
  })

  it("honors the saved Actor call budget before dispatching the format correction", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({ maxRuns: 1, maxDurationSec: 60 })
    value.runAgent.mockResolvedValue("{invalid plan JSON")

    await coordinate(value.mission, value.ports)

    expect(value.runAgent).toHaveBeenCalledOnce()
    expect(value.mission.status).toBe("paused")
    expect(value.mission.execution).toMatchObject({ runsStarted: 1, failureKind: "budget" })
    expect(value.mission.plan).toBeUndefined()
    expect(value.mission.supervision?.pendingRecovery).toBeUndefined()
    expect(value.verify).not.toHaveBeenCalled()
  })

  it("propagates a read-only violation without attempting a second plan", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({ maxRuns: 20, maxDurationSec: 60 })
    value.runAgent.mockImplementation(async () => {
      value.mutate("unexpected-plan-edit")
      return "{invalid plan JSON"
    })

    await expect(coordinate(value.mission, value.ports)).rejects.toThrow("plan Actor changed the worktree")

    expect(value.runAgent).toHaveBeenCalledOnce()
    expect(value.mission.status).toBe("failed")
    expect(value.mission.execution?.failureKind).toBe("integrity")
    expect(value.mission.plan).toBeUndefined()
    expect(value.verify).not.toHaveBeenCalled()
  })
})
