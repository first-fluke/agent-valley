import { describe, expect, it } from "vitest"
import { coordinate } from "./coordinator"
import { brief, fixture, plan, rejected } from "./goal-supervision.fixture"
import { finalCriteria, validateMission } from "./schemas"

describe("durable Chief Director goal supervision", () => {
  it("persists a concrete brief for a vague goal before dispatch and reports the evidenced outcome", async () => {
    const { mission, ports, runAgent, snapshots } = fixture()
    await coordinate(mission, ports)
    expect(mission.goalBrief).toEqual(brief)
    expect(mission.supervision?.originalAcceptance).toEqual(plan.tasks[0]?.acceptance)
    expect(snapshots.find((value) => value.plan)?.goalBrief).toEqual(brief)
    expect(runAgent.mock.calls.find((call) => call[3] === "work")?.[1]).toContain(brief.successCriteria[0])
    expect(mission.status).toBe("completed")
    expect(mission.finalReview?.criteria?.map((entry) => entry.criterion)).toEqual(finalCriteria(mission))
    expect(mission.report?.eli5.length).toBeGreaterThan(20)
    expect(runAgent.mock.calls.at(-1)?.[3]).toBe("report")
    expect(runAgent.mock.calls.at(-1)?.[2].status).toBe("completed")
    expect(mission.supervision?.rounds).toBe(0)
  })

  it("keeps bounded local task and verification repairs before requiring Chief Director policy", async () => {
    const { mission, ports, runAgent, verify } = fixture()
    mission.maxRepairs = 1
    const original = runAgent.getMockImplementation()
    let reviews = 0
    runAgent.mockImplementation(async (...args) =>
      args[3] === "review" && reviews++ === 0 ? rejected : ((await original?.(...args)) ?? ""),
    )
    verify.mockResolvedValueOnce({ ok: false, output: "Acceptance command found missing state" })
    await coordinate(mission, ports)
    expect(mission.tasks[0]?.repairRound).toBe(1)
    expect(mission.repairRound).toBe(1)
    expect(runAgent.mock.calls.filter((call) => call[3] === "work")).toHaveLength(3)
    expect(runAgent.mock.calls.some((call) => call[3] === "supervise")).toBe(false)
    expect(mission.report).toBeDefined()
  })

  it("reassigns exhausted work and recomputes an independent reviewer before dispatch", async () => {
    const { mission, ports, runAgent, snapshots } = fixture()
    const original = runAgent.getMockImplementation()
    let reviews = 0
    runAgent.mockImplementation(async (...args) => {
      if (args[3] === "review" && reviews++ === 0) return rejected
      if (args[3] === "supervise") {
        expect(args[0]).toMatchObject({ id: "chief", agentType: "codex", model: "operator-model" })
        expect(args[1]).toContain("Handle the empty-account onboarding state")
        expect(args[1]).toContain("Changed onboarding.ts")
        return JSON.stringify({
          action: "reassign",
          reason: "Another specialist can handle this missing state.",
          taskId: "onboarding",
          personaId: "reviewer",
          instructions: "Repair empty-account onboarding and provide acceptance evidence.",
        })
      }
      if (args[3] === "work" && args[0].id === "reviewer") {
        expect(snapshots.at(-1)?.supervision?.decisions[0]?.action).toBe("reassign")
        expect(snapshots.at(-1)?.tasks[0]?.reviewerId).toBe("chief")
      }
      return (await original?.(...args)) ?? ""
    })
    await coordinate(mission, ports)
    expect(runAgent.mock.calls.filter((call) => call[3] === "work").map((call) => call[0].id)).toEqual([
      "worker",
      "reviewer",
    ])
    expect(mission.tasks[0]?.reviewerId).toBe("chief")
    expect(mission.supervision?.rounds).toBe(1)
    expect(mission.goalBrief).toEqual(brief)
  })

  it("replans tasks while retaining original obligations, reviewed failure evidence and the saved brief", async () => {
    const { mission, ports, runAgent } = fixture()
    const original = runAgent.getMockImplementation()
    let reviews = 0
    runAgent.mockImplementation(async (...args) => {
      if (args[3] === "review" && reviews++ === 0) return rejected
      if (args[3] === "supervise")
        return JSON.stringify({
          action: "replan",
          reason: "Separate the missing first-time state into a replacement task.",
          tasks: [{ ...plan.tasks[0], id: "empty-account", personaId: "reviewer" }],
        })
      return (await original?.(...args)) ?? ""
    })
    await coordinate(mission, ports)
    expect(mission.plan?.tasks[0]?.id).toBe("empty-account")
    expect(mission.goalBrief).toEqual(brief)
    expect(mission.supervision?.originalAcceptance).toEqual(plan.tasks[0]?.acceptance)
    expect(mission.supervision?.decisions[0]?.previousTasks?.[0]?.review?.passed).toBe(false)
    expect(mission.supervision?.decisions[0]?.previousTasks?.[0]?.output).toContain("onboarding.ts")
    expect(mission.tasks[0]?.reviewerId).toBe("chief")
    expect(validateMission(mission).status).toBe("completed")
  })

  it("checkpoints a failed Chief Director call and resumes its pending decision before another Actor", async () => {
    const { mission, ports, runAgent } = fixture()
    const original = runAgent.getMockImplementation()
    let workFailed = false
    let chiefFailed = false
    runAgent.mockImplementation(async (...args) => {
      if (args[3] === "work" && !workFailed) {
        workFailed = true
        throw new Error("Worker disconnected")
      }
      if (args[3] === "supervise" && !chiefFailed) {
        chiefFailed = true
        throw new Error("Chief Director disconnected")
      }
      return (await original?.(...args)) ?? ""
    })
    await expect(coordinate(mission, ports)).rejects.toThrow("Chief Director disconnected")
    expect(mission.supervision).toMatchObject({
      rounds: 1,
      decisions: [],
      pendingRecovery: { reason: "Worker disconnected", taskId: "onboarding" },
    })
    expect(mission.report).toBeDefined()
    const resumed = validateMission(structuredClone(mission))
    runAgent.mockClear()
    await coordinate(resumed, ports)
    expect(runAgent.mock.calls[0]?.[3]).toBe("supervise")
    expect(runAgent.mock.calls.some((call) => call[3] === "plan")).toBe(false)
    expect(resumed.supervision?.rounds).toBe(2)
    expect(resumed.supervision?.pendingRecovery).toBeUndefined()
    expect(resumed.tasks[0]?.attempts).toBe(2)
    expect(resumed.status).toBe("completed")
  })

  it("never resets an exhausted recovery budget on resume", async () => {
    const { mission, ports, runAgent } = fixture()
    if (mission.supervision) mission.supervision.maxRounds = 1
    const original = runAgent.getMockImplementation()
    runAgent.mockImplementation(async (...args) =>
      args[3] === "review" ? rejected : ((await original?.(...args)) ?? ""),
    )
    await expect(coordinate(mission, ports)).rejects.toThrow("exhausted 1 rounds")
    expect(mission.supervision?.rounds).toBe(1)
    expect(mission.report).toBeDefined()
    runAgent.mockClear()
    await expect(coordinate(validateMission(structuredClone(mission)), ports)).rejects.toThrow("exhausted 1 rounds")
    expect(runAgent.mock.calls.every((call) => call[3] === "report")).toBe(true)
  })

  it("fails after three unchanged recovery rounds and persists that stall across resume", async () => {
    const { mission, ports, runAgent } = fixture()
    const original = runAgent.getMockImplementation()
    runAgent.mockImplementation(async (...args) =>
      args[3] === "work"
        ? "No deliverable could be changed."
        : args[3] === "review"
          ? rejected
          : ((await original?.(...args)) ?? ""),
    )
    await expect(coordinate(mission, ports)).rejects.toThrow("stalled for three rounds")
    expect(mission.supervision?.stalledRounds).toBe(3)
    expect(mission.supervision?.rounds).toBe(3)
    expect(runAgent.mock.calls.filter((call) => call[3] === "supervise")).toHaveLength(2)
    runAgent.mockClear()
    await expect(coordinate(validateMission(structuredClone(mission)), ports)).rejects.toThrow(
      "stalled for three rounds",
    )
    expect(runAgent.mock.calls.every((call) => call[3] === "report")).toBe(true)
  })

  it("honors a saved stop decision without restarting work", async () => {
    const { mission, ports, runAgent } = fixture()
    const original = runAgent.getMockImplementation()
    runAgent.mockImplementation(async (...args) =>
      args[3] === "review"
        ? rejected
        : args[3] === "supervise"
          ? JSON.stringify({ action: "stop", reason: "Required source data is absent." })
          : ((await original?.(...args)) ?? ""),
    )
    await expect(coordinate(mission, ports)).rejects.toThrow("Chief Director stopped")
    expect(mission.supervision?.decisions.at(-1)?.action).toBe("stop")
    runAgent.mockClear()
    await expect(coordinate(validateMission(structuredClone(mission)), ports)).rejects.toThrow("Chief Director stopped")
    expect(runAgent.mock.calls.every((call) => call[3] === "report")).toBe(true)
  })

  it.each(["verify", "final-review"])(
    "routes a %s process failure through a saved Chief Director repair",
    async (stage) => {
      const { mission, ports, runAgent, verify } = fixture()
      const original = runAgent.getMockImplementation()
      if (stage === "verify") verify.mockRejectedValueOnce(new Error("Verification runner disconnected"))
      let failed = false
      runAgent.mockImplementation(async (...args) => {
        if (stage === "final-review" && args[3] === stage && !failed) {
          failed = true
          throw new Error("Final reviewer disconnected")
        }
        return (await original?.(...args)) ?? ""
      })
      await coordinate(mission, ports)
      expect(mission.supervision?.decisions[0]?.action).toBe("repair")
      expect(verify).toHaveBeenCalledTimes(2)
      expect(mission.status).toBe("completed")
    },
  )

  it("rejects a weak replan before persisting or dispatching it", async () => {
    const { mission, ports, runAgent } = fixture()
    const original = runAgent.getMockImplementation()
    runAgent.mockImplementation(async (...args) =>
      args[3] === "review"
        ? rejected
        : args[3] === "supervise"
          ? JSON.stringify({
              action: "replan",
              reason: "Drop the failing obligation",
              tasks: [{ ...plan.tasks[0], acceptance: ["A file exists"] }],
            })
          : ((await original?.(...args)) ?? ""),
    )
    await expect(coordinate(mission, ports)).rejects.toThrow("weakens an original acceptance obligation")
    expect(mission.plan?.tasks).toEqual(plan.tasks)
    expect(mission.supervision?.decisions).toEqual([])
    expect(runAgent.mock.calls.filter((call) => call[3] === "work")).toHaveLength(1)
    expect(mission.status).toBe("failed")
  })
})
