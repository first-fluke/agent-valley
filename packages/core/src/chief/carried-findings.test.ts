import { describe, expect, it } from "vitest"
import { carryOpenFindings } from "./carried-findings"
import { fixture, plan } from "./goal-supervision.fixture"
import { taskStateSchema } from "./mission-state-schema"
import type { Mission } from "./types"

const finding = "UNRESOLVED: 'Prove the restart case.' The test never observes a failed scan."

function rejectedLane(): Mission {
  const { mission } = fixture()
  const task = plan.tasks[0]
  if (!task) throw new Error("Expected a fixture task")
  mission.maxRepairs = 2
  mission.fingerprint = "integrated"
  mission.plan = {
    tasks: [
      { ...task, id: "lane" },
      { ...task, id: "qa", dependencies: ["lane"] },
      { ...task, id: "integration", dependencies: ["lane", "qa"] },
    ],
  }
  mission.tasks = [
    {
      id: "lane",
      reviewerId: "reviewer",
      status: "pending",
      attempts: 3,
      repairRound: 2,
      fingerprint: "reviewed",
      review: { passed: false, summary: "One finding is still open.", findings: [finding], followUps: ["Rename it."] },
    },
    { id: "qa", reviewerId: "reviewer", status: "pending", attempts: 0 },
    { id: "integration", reviewerId: "reviewer", status: "pending", attempts: 0 },
  ]
  if (mission.supervision) mission.supervision.originalAcceptance = [...task.acceptance]
  return mission
}

const stateOf = (mission: Mission, id: string) => mission.tasks.find((state) => state.id === id)
const taskOf = (mission: Mission, id: string) => mission.plan?.tasks.find((task) => task.id === id)

describe("carrying open findings past a task whose repairs are spent", () => {
  it("accepts the integrated delivery and makes the findings obligations of the last dependent task", () => {
    const mission = rejectedLane()
    const message = carryOpenFindings(mission, "lane")
    expect(message).toContain("integration")
    const lane = stateOf(mission, "lane")
    expect(lane?.status).toBe("completed")
    expect(lane?.carriedTo).toBe("integration")
    expect(lane?.fingerprint).toBe("reviewed")
    expect(lane?.output).toContain("integrated in the mission workspace")
    expect(lane?.review?.passed).toBe(true)
    expect(lane?.review?.findings).toEqual([])
    expect(lane?.review?.followUps).toEqual([`Carried to integration: ${finding}`, "Rename it."])
    expect(lane?.review?.summary).toContain("carried 1 open finding(s) to integration")
    expect(() => taskStateSchema.parse(lane)).not.toThrow()
    const obligation = `Carried from lane; resolved in this task or shown with evidence not to apply: ${finding}`
    expect(taskOf(mission, "integration")?.acceptance.at(-1)).toBe(obligation)
    expect(taskOf(mission, "integration")?.instructions).toContain("Findings carried from lane")
    expect(mission.supervision?.originalAcceptance).toContain(obligation)
    expect(taskOf(mission, "qa")?.acceptance).toEqual(plan.tasks[0]?.acceptance)
  })

  it("leaves a task that still has a local repair to that repair", () => {
    const mission = rejectedLane()
    const lane = stateOf(mission, "lane")
    if (lane) lane.repairRound = 1
    expect(carryOpenFindings(mission, "lane")).toBeUndefined()
    expect(lane?.status).toBe("pending")
    expect(lane?.review?.passed).toBe(false)
  })

  it("never carries when the mission allows no local repair", () => {
    const mission = rejectedLane()
    mission.maxRepairs = 0
    const lane = stateOf(mission, "lane")
    if (lane) lane.repairRound = 0
    expect(carryOpenFindings(mission, "lane")).toBeUndefined()
  })

  it.each(["SEVERE: the store loses a frontier on merge.", "CHECK: cargo test failed in the lane's own target."])(
    "keeps %s with the Chief's recovery decision",
    (held) => {
      const mission = rejectedLane()
      const lane = stateOf(mission, "lane")
      lane?.review?.findings.push(held)
      expect(carryOpenFindings(mission, "lane")).toBeUndefined()
      expect(lane?.status).toBe("pending")
      expect(taskOf(mission, "integration")?.acceptance).toEqual(plan.tasks[0]?.acceptance)
    },
  )

  it("does not carry to a task that has already started or when nothing waits on the delivery", () => {
    const started = rejectedLane()
    for (const id of ["qa", "integration"]) {
      const state = stateOf(started, id)
      if (state) state.output = "Delivered."
    }
    expect(carryOpenFindings(started, "lane")).toBeUndefined()
    const alone = rejectedLane()
    if (alone.plan) alone.plan.tasks = alone.plan.tasks.map((task) => ({ ...task, dependencies: [] }))
    expect(carryOpenFindings(alone, "lane")).toBeUndefined()
  })

  it("carries a task a replan left without its own fingerprint, using the integrated tree's", () => {
    const mission = rejectedLane()
    const lane = stateOf(mission, "lane")
    if (lane) {
      delete lane.fingerprint
      lane.status = "running"
    }
    expect(carryOpenFindings(mission, "lane")).toBeDefined()
    expect(lane?.fingerprint).toBe("integrated")
    expect(lane?.status).toBe("completed")
  })
})
