import { describe, expect, it, vi } from "vitest"
import { executionPolicySchema } from "./contracts"
import { coordinate } from "./coordinator"
import { brief, fixture, passed, plan } from "./goal-supervision.fixture"
import type { TaskWorktreeRecord } from "./parallel-workspace"
import type { Mission } from "./types"

function barrier() {
  let release: () => void = () => {}
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}

function record(mission: Mission, taskId: string, attempt: number): TaskWorktreeRecord {
  return {
    version: 1,
    missionId: mission.id,
    taskId,
    attempt,
    sourceWorkspacePath: mission.workspace.path,
    path: `/private/actor-${taskId}`,
    branch: `av-task/${taskId}`,
    baselineHead: "a".repeat(40),
    baselineTree: "b".repeat(40),
  }
}

describe("concurrent independent task reviews through the coordinator", () => {
  it("overlaps review Actor calls and completes every task without deadlocking the shared checkpoint queue", async () => {
    const value = fixture()
    const task = plan.tasks[0]
    if (!task) throw new Error("Expected a fixture task")
    value.mission.executionPolicy = executionPolicySchema.parse({ maxParallel: 2 })
    value.mission.plan = {
      tasks: [
        { ...task, id: "a" },
        { ...task, id: "b" },
      ],
    }
    value.mission.tasks = [
      { id: "a", reviewerId: "reviewer", status: "pending", attempts: 0 },
      { id: "b", reviewerId: "reviewer", status: "pending", attempts: 0 },
    ]
    value.mission.goalBrief = brief
    if (value.mission.supervision)
      value.mission.supervision.originalAcceptance = value.mission.plan.tasks.flatMap((entry) => entry.acceptance)
    value.ports.parallel = {
      prepare: vi.fn(async (_mission, taskId, attempt) => record(value.mission, taskId, attempt)),
      integrate: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    }
    const bothReviewing = barrier()
    const finish = barrier()
    let reviewCount = 0
    let reviewActive = 0
    let maxReviewActive = 0
    const base = value.runAgent.getMockImplementation()
    value.runAgent.mockImplementation(async (...args) => {
      const stage = args[3]
      if (stage === "review") {
        reviewActive += 1
        maxReviewActive = Math.max(maxReviewActive, reviewActive)
        if (++reviewCount === 2) bothReviewing.release()
        await finish.wait
        reviewActive -= 1
        return passed
      }
      if (!base) throw new Error("Missing fixture Actor implementation")
      return base(...args)
    })
    const running = coordinate(value.mission, value.ports)
    await bothReviewing.wait
    expect(maxReviewActive).toBe(2)
    finish.release()
    const mission = await running
    expect(mission.status).toBe("completed")
    expect(maxReviewActive).toBe(2)
    expect(mission.tasks.every((state) => state.status === "completed" && state.review?.passed)).toBe(true)
    expect(value.ports.parallel.dispose).toHaveBeenCalledTimes(2)
  })

  it("re-isolates the repair of a single task whose isolated delivery was rejected", async () => {
    const value = fixture()
    const task = plan.tasks[0]
    if (!task) throw new Error("Expected a fixture task")
    value.mission.executionPolicy = executionPolicySchema.parse({ maxParallel: 2 })
    value.mission.plan = { tasks: [{ ...task, id: "a" }] }
    value.mission.tasks = [{ id: "a", reviewerId: "reviewer", status: "pending", attempts: 1, repairRound: 1 }]
    value.mission.goalBrief = brief
    if (value.mission.supervision)
      value.mission.supervision.originalAcceptance = value.mission.plan.tasks.flatMap((entry) => entry.acceptance)
    value.mission.history.push({
      at: new Date().toISOString(),
      stage: "parallel-review-rejected",
      taskId: "a",
      message: "Task a failed independent review: stale contract. Actor edits retained at /private/actor-a.",
    })
    value.ports.parallel = {
      prepare: vi.fn(async (_mission, taskId, attempt) => record(value.mission, taskId, attempt)),
      integrate: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    }
    const base = value.runAgent.getMockImplementation()
    value.runAgent.mockImplementation(async (...args) => {
      if (args[3] === "review") return passed
      if (!base) throw new Error("Missing fixture Actor implementation")
      return base(...args)
    })
    const mission = await coordinate(value.mission, value.ports)
    expect(mission.status).toBe("completed")
    expect(value.ports.parallel.prepare).toHaveBeenCalledWith(expect.anything(), "a", 2)
    expect(value.ports.parallel.integrate).toHaveBeenCalledTimes(1)
  })
})
