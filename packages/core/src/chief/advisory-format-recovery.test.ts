import { describe, expect, it } from "vitest"
import { coordinate } from "./coordinator"
import { executionPolicySchema, MissionPause } from "./execution"
import { fixture } from "./goal-supervision.fixture"
import { CMO_ROLE } from "./marketing-lead"

const advice = {
  passed: false,
  summary: "No current revenue measurements; preserve the scoped code goal.",
  findings: ["Verify the actual feature before publishing."],
}
function advisoryFixture() {
  const value = fixture()
  value.mission.marketingLeadId = "cmo"
  value.mission.personas.push({
    id: "cmo",
    name: "Marketing Director",
    role: CMO_ROLE,
    agentType: "codex",
    model: "pinned-advisor",
    skills: [],
  })
  value.mission.executionPolicy = executionPolicySchema.parse({ maxRuns: 20 })
  value.mission.execution = { startedAt: new Date().toISOString(), runsStarted: 0, retries: 0 }
  return value
}

describe("bounded advisory response correction", () => {
  it("corrects malformed JSON with the same Director and preserves real task approval and original budget", async () => {
    const { mission, ports, runAgent } = advisoryFixture()
    const startedAt = mission.execution?.startedAt
    const original = runAgent.getMockImplementation()
    let attempts = 0
    runAgent.mockImplementation(async (...args) =>
      args[3] === "marketing-review"
        ? ++attempts === 1
          ? "not JSON"
          : JSON.stringify(advice)
        : ((await original?.(...args)) ?? ""),
    )
    await coordinate(mission, ports)
    expect(mission.status).toBe("completed")
    const calls = runAgent.mock.calls.filter((call) => call[3] === "marketing-review")
    expect(calls).toHaveLength(2)
    expect(calls.every((call) => call[0].id === "cmo" && call[0].model === "pinned-advisor")).toBe(true)
    expect(calls[1]?.[1]).toContain("original schema")
    expect(mission.marketingReview?.review).toEqual(advice)
    expect(mission.execution).toMatchObject({ startedAt, runsStarted: 6, retries: 0 })
    expect(mission.tasks.every((task) => task.review?.passed)).toBe(true)
    expect(mission.verification?.ok).toBe(true)
    expect(mission.finalReview?.passed).toBe(true)
  })

  it("hands exhausted optional advice to the Chief as unavailable rather than fabricating a review", async () => {
    const { mission, ports, runAgent } = advisoryFixture()
    const original = runAgent.getMockImplementation()
    runAgent.mockImplementation(async (...args) => {
      if (args[3] === "marketing-review") return "not JSON"
      if (args[3] === "plan") {
        expect(args[1]).toContain("unavailableDirectorAdvice")
        expect(args[1]).toContain("not approval")
        expect(mission.marketingReview).toBeUndefined()
      }
      return (await original?.(...args)) ?? ""
    })
    await coordinate(mission, ports)
    expect(mission.status).toBe("completed")
    expect(runAgent.mock.calls.filter((call) => call[3] === "marketing-review")).toHaveLength(2)
    expect(mission.marketingReview).toBeUndefined()
    expect(mission.history.some((entry) => entry.stage === "director-advice-unavailable")).toBe(true)
    expect(mission.tasks.every((task) => task.review?.passed)).toBe(true)
    expect(mission.verification?.ok && mission.finalReview?.passed).toBe(true)
  })

  it("does not downgrade an unknown run outcome into optional missing advice", async () => {
    const { mission, ports, runAgent } = advisoryFixture()
    const original = runAgent.getMockImplementation()
    runAgent.mockImplementation(async (...args) => {
      if (args[3] === "marketing-review") throw new MissionPause("Unconfirmed execution", "unknown-effect")
      return (await original?.(...args)) ?? ""
    })
    await coordinate(mission, ports)
    expect(mission.status).toBe("paused")
    expect(mission.plan).toBeUndefined()
    expect(runAgent.mock.calls.filter((call) => call[3] === "marketing-review")).toHaveLength(1)
    expect(mission.history.some((entry) => entry.stage === "director-advice-unavailable")).toBe(false)
  })

  it("does not dispatch a correction after the original run allowance is spent", async () => {
    const { mission, ports, runAgent } = advisoryFixture()
    mission.executionPolicy = executionPolicySchema.parse({ maxRuns: 1 })
    runAgent.mockResolvedValue("not JSON")
    await coordinate(mission, ports)
    expect(mission.status).toBe("paused")
    expect(mission.execution).toMatchObject({ runsStarted: 1, failureKind: "budget" })
    expect(runAgent).toHaveBeenCalledOnce()
    expect(mission.marketingReview).toBeUndefined()
  })
})
