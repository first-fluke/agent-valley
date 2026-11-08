import { describe, expect, it } from "vitest"
import { coordinate } from "./coordinator"
import { executionPolicySchema } from "./execution"
import { brief, fixture, plan, rejected } from "./goal-supervision.fixture"
import { applyRecovery } from "./supervision"
import type { ChiefTaskState } from "./types"

function completedMission(ids: string[], dependencies: Record<string, string[]> = {}) {
  const value = fixture()
  const task = plan.tasks[0]
  if (!task) throw new Error("Expected fixture task")
  value.mission.plan = {
    tasks: ids.map((id) => ({
      ...task,
      id,
      title: id,
      acceptance: [`Verified ${id}`],
      dependencies: dependencies[id] ?? [],
    })),
  }
  value.mission.tasks = ids.map((id) => ({
    id,
    reviewerId: "reviewer",
    status: "completed" as const,
    attempts: 1,
    output: `Approved output for ${id}`,
    review: { passed: true, summary: `Verified ${id}`, findings: [] },
    fingerprint: `fingerprint-${id}`,
  }))
  value.mission.goalBrief = brief
  if (value.mission.supervision) value.mission.supervision.originalAcceptance = ids.map((id) => `Verified ${id}`)
  return value
}

function stateOf(tasks: ChiefTaskState[], id: string): ChiefTaskState {
  const state = tasks.find((entry) => entry.id === id)
  if (!state) throw new Error(`Missing task state ${id}`)
  return state
}

describe("targeted recovery keeps completed tasks completed", () => {
  it("keeps task-1 and task-7 completed when a repair names task-2", () => {
    const value = completedMission(["task-1", "task-2", "task-7"])
    if (value.mission.supervision)
      value.mission.supervision.pendingRecovery = { taskId: "task-2", reason: "Independent review rejected task-2" }
    const before = structuredClone(value.mission.tasks)
    applyRecovery(value.mission, {
      action: "repair",
      reason: "Repair the rejected deliverable",
      taskId: "task-2",
      instructions: "Resolve the recorded finding.",
    })
    expect(stateOf(value.mission.tasks, "task-1")).toEqual(stateOf(before, "task-1"))
    expect(stateOf(value.mission.tasks, "task-7")).toEqual(stateOf(before, "task-7"))
    expect(stateOf(value.mission.tasks, "task-2").status).toBe("pending")
    expect(
      value.mission.history.filter((entry) => entry.stage === "task-preserved").map((entry) => entry.taskId),
    ).toEqual(["task-1", "task-7"])
  })

  it("resets direct and transitive dependents of the repaired task", () => {
    const value = completedMission(["task-1", "task-2", "task-3", "task-7"], {
      "task-2": ["task-1"],
      "task-3": ["task-2"],
    })
    applyRecovery(value.mission, {
      action: "repair",
      reason: "Repair the prerequisite",
      taskId: "task-1",
      instructions: "Resolve the recorded finding.",
    })
    expect(stateOf(value.mission.tasks, "task-1").status).toBe("pending")
    expect(stateOf(value.mission.tasks, "task-2")).toMatchObject({
      status: "reviewing",
      output: "Approved output for task-2",
    })
    expect(stateOf(value.mission.tasks, "task-2").review).toBeUndefined()
    expect(stateOf(value.mission.tasks, "task-3")).toMatchObject({
      status: "reviewing",
      output: "Approved output for task-3",
    })
    expect(stateOf(value.mission.tasks, "task-3").review).toBeUndefined()
    expect(stateOf(value.mission.tasks, "task-7").status).toBe("completed")
    expect(
      value.mission.history.filter((entry) => entry.stage === "task-preserved").map((entry) => entry.taskId),
    ).toEqual(["task-7"])
  })

  it("preserves unrelated completed tasks through a replan that changes only task-2", () => {
    const value = completedMission(["task-1", "task-2", "task-7"])
    if (!value.mission.plan) throw new Error("Expected fixture plan")
    const tasks = structuredClone(value.mission.plan.tasks)
    const changed = tasks.find((entry) => entry.id === "task-2")
    if (!changed) throw new Error("Expected task-2")
    changed.instructions = "Implement the corrected assignment."
    applyRecovery(value.mission, { action: "replan", reason: "Change only task-2", tasks })
    expect(stateOf(value.mission.tasks, "task-1").status).toBe("completed")
    expect(stateOf(value.mission.tasks, "task-7").status).toBe("completed")
    expect(stateOf(value.mission.tasks, "task-2").status).toBe("pending")
    expect(
      value.mission.history.filter((entry) => entry.stage === "task-preserved").map((entry) => entry.taskId),
    ).toEqual(["task-1", "task-7"])
  })

  it("still resets the interrupted task when an unchanged replan retries it", () => {
    const value = completedMission(["task-1", "task-2"])
    if (!value.mission.plan) throw new Error("Expected fixture plan")
    if (value.mission.supervision)
      value.mission.supervision.pendingRecovery = { taskId: "task-1", reason: "Retry the interrupted task" }
    applyRecovery(value.mission, {
      action: "replan",
      reason: "Retry with the same assignments",
      tasks: structuredClone(value.mission.plan.tasks),
    })
    expect(stateOf(value.mission.tasks, "task-1").status).toBe("reviewing")
    expect(stateOf(value.mission.tasks, "task-1").review).toBeUndefined()
    expect(stateOf(value.mission.tasks, "task-2").status).toBe("completed")
  })

  it("refreshes a completed approval that has no recorded deliverable fingerprint", () => {
    const value = completedMission(["task-1", "task-2"])
    delete stateOf(value.mission.tasks, "task-1").fingerprint
    applyRecovery(value.mission, {
      action: "repair",
      reason: "Repair task-2",
      taskId: "task-2",
      instructions: "Resolve the recorded finding.",
    })
    expect(stateOf(value.mission.tasks, "task-1").status).toBe("reviewing")
    expect(stateOf(value.mission.tasks, "task-1").review).toBeUndefined()
    expect(value.mission.history.some((entry) => entry.stage === "task-preserved")).toBe(false)
  })

  it("repairs the last delivered task and keeps its completed siblings when a repair names no target", () => {
    const value = completedMission(["task-1", "task-2"])
    applyRecovery(value.mission, {
      action: "repair",
      reason: "Mission-wide repair",
      instructions: "Resolve the recorded finding everywhere.",
    })
    expect(stateOf(value.mission.tasks, "task-2").status).toBe("pending")
    expect(stateOf(value.mission.tasks, "task-1").status).toBe("completed")
    const instructions = (id: string) => value.mission.plan?.tasks.find((task) => task.id === id)?.instructions ?? ""
    expect(instructions("task-2")).toContain("Chief Director recovery:")
    expect(instructions("task-1")).not.toContain("Chief Director recovery:")
    expect(
      value.mission.history.filter((entry) => entry.stage === "task-preserved").map((entry) => entry.taskId),
    ).toEqual(["task-1"])
  })

  it("does not re-review passed siblings after a Chief repair names the failed task", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({ maxParallel: 1, maxRetries: 0 })
    const task = plan.tasks[0]
    if (!task) throw new Error("Expected fixture task")
    const tasks = ["task-1", "task-7", "task-2"].map((id) => ({
      ...task,
      id,
      title: id,
      acceptance: [`Verified ${id}`],
    }))
    const base = value.runAgent.getMockImplementation()
    let rejectedOnce = false
    value.runAgent.mockImplementation(async (...args) => {
      if (args[3] === "plan") return JSON.stringify({ tasks, goalBrief: brief })
      if (args[3] === "review" && args[4]?.taskId === "task-2" && !rejectedOnce) {
        rejectedOnce = true
        return rejected
      }
      if (args[3] === "supervise")
        return JSON.stringify({
          action: "repair",
          reason: "Repair the rejected task-2 deliverable",
          taskId: "task-2",
          instructions: "Resolve the recorded finding.",
        })
      return (await base?.(...args)) ?? ""
    })
    expect((await coordinate(value.mission, value.ports)).status).toBe("completed")
    const reviews = value.runAgent.mock.calls.filter((call) => call[3] === "review")
    expect(reviews.filter((call) => call[4]?.taskId === "task-1")).toHaveLength(1)
    expect(reviews.filter((call) => call[4]?.taskId === "task-7")).toHaveLength(1)
    expect(reviews.filter((call) => call[4]?.taskId === "task-2")).toHaveLength(2)
    const work = value.runAgent.mock.calls.filter((call) => call[3] === "work")
    expect(work.filter((call) => call[4]?.taskId === "task-1")).toHaveLength(1)
    expect(work.filter((call) => call[4]?.taskId === "task-7")).toHaveLength(1)
    expect(work.filter((call) => call[4]?.taskId === "task-2")).toHaveLength(2)
    expect(
      value.mission.history.filter((entry) => entry.stage === "task-preserved").map((entry) => entry.taskId),
    ).toEqual(["task-1", "task-7"])
  })
})
