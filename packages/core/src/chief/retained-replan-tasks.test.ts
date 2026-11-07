import { describe, expect, it } from "vitest"
import { actorTaskData } from "./actor-contract"
import { brief, fixture, plan } from "./goal-supervision.fixture"
import { applyRecovery } from "./supervision"
import { parseSupervisionResponse } from "./supervision-contract"

function acceptedMission() {
  const value = fixture()
  const task = plan.tasks[0]
  if (!task) throw new Error("Expected fixture task")
  value.mission.plan = {
    tasks: ["task-1", "task-2"].map((id) => ({
      ...task,
      id,
      title: id,
      acceptance: [`Verified ${id}`],
      dependencies: id === "task-2" ? ["task-1"] : [],
    })),
  }
  value.mission.tasks = [
    {
      id: "task-1",
      reviewerId: "reviewer",
      status: "completed",
      attempts: 1,
      output: "Approved output for task-1",
      review: { passed: true, summary: "Verified task-1", findings: [] },
      fingerprint: "fingerprint-task-1",
    },
    { id: "task-2", reviewerId: "reviewer", status: "pending", attempts: 2 },
  ]
  value.mission.goalBrief = brief
  if (value.mission.supervision) {
    value.mission.supervision.originalAcceptance = ["Verified task-1", "Verified task-2"]
    value.mission.supervision.pendingRecovery = { taskId: "task-2", reason: "Independent review rejected task-2" }
  }
  return value.mission
}

describe("retained replan tasks", () => {
  it("keeps an accepted task's recorded definition and completed state when the Chief marks it retain", () => {
    const mission = acceptedMission()
    const previous = mission.plan?.tasks[0]
    const rejected = mission.plan?.tasks[1]
    if (!previous || !rejected) throw new Error("Expected plan tasks")
    const decision = parseSupervisionResponse(
      JSON.stringify({
        action: "replan",
        reason: "Repair task-2 and keep the accepted contract.",
        tasks: [
          { id: "task-1", retain: true },
          { ...actorTaskData(rejected), instructions: "Repair the SSH option boundary and add regressions." },
        ],
      }),
      mission,
    )
    if (decision.action !== "replan") throw new Error("Expected a replan")
    expect(decision.tasks[0]).toEqual(previous)
    applyRecovery(mission, decision)
    expect(mission.tasks.find((state) => state.id === "task-1")).toMatchObject({
      status: "completed",
      output: "Approved output for task-1",
      fingerprint: "fingerprint-task-1",
    })
    expect(mission.tasks.find((state) => state.id === "task-2")?.status).toBe("pending")
    expect(mission.history.filter((entry) => entry.stage === "task-preserved").map((entry) => entry.taskId)).toEqual([
      "task-1",
    ])
  })

  it("ignores retain on a task that was never accepted and requires a full definition", () => {
    const mission = acceptedMission()
    const accepted = mission.plan?.tasks[0]
    if (!accepted) throw new Error("Expected plan task")
    expect(() =>
      parseSupervisionResponse(
        JSON.stringify({
          action: "replan",
          reason: "Retain flags cannot stand in for an unaccepted task.",
          tasks: [actorTaskData(accepted), { id: "task-2", retain: true }],
        }),
        mission,
      ),
    ).toThrow()
  })
})
