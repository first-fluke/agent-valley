import { describe, expect, it, vi } from "vitest"
import { executionPolicySchema } from "./contracts"
import { coordinate } from "./coordinator"
import { brief, fixture, passed, plan, rejected } from "./goal-supervision.fixture"
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

  it("runs a single-task repair directly in-place when direct changeSet capture is available", async () => {
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
    const freshChangeSet = {
      version: 1 as const,
      inputTree: "1".repeat(40),
      deliveryTree: "2".repeat(40),
      files: [{ path: "docs/traceability.md", status: "modified" as const, size: 42, sha256: "3".repeat(64) }],
      diff: "diff --git a/docs/traceability.md b/docs/traceability.md",
      diffTruncated: false,
    }
    value.ports.captureWorkspaceTree = vi.fn(async () => freshChangeSet.inputTree)
    value.ports.collectDirectChangeSet = vi.fn(async () => freshChangeSet)
    const base = value.runAgent.getMockImplementation()
    value.runAgent.mockImplementation(async (...args) => {
      if (args[3] === "review") return passed
      if (!base) throw new Error("Missing fixture Actor implementation")
      return base(...args)
    })
    const mission = await coordinate(value.mission, value.ports)
    expect(mission.status).toBe("completed")
    expect(value.ports.parallel.prepare).not.toHaveBeenCalled()
    expect(value.ports.parallel.integrate).not.toHaveBeenCalled()
    expect(value.ports.captureWorkspaceTree).toHaveBeenCalledTimes(1)
    expect(value.ports.collectDirectChangeSet).toHaveBeenCalledWith(mission.workspace.path, freshChangeSet.inputTree)
    expect(mission.tasks[0]?.changeSet).toEqual(freshChangeSet)
    expect(mission.tasks[0]?.fingerprint).toBe("change-1")
    expect(mission.fingerprint).toBe("change-1")
  })

  it("runs returned-findings review for a direct single-task final wave before spending an integration check", async () => {
    const value = fixture()
    const task = plan.tasks[0]
    if (!task) throw new Error("Expected a fixture task")
    value.mission.maxRepairs = 2
    value.mission.executionPolicy = executionPolicySchema.parse({ maxParallel: 2 })
    value.mission.initialFingerprint = "initial"
    value.mission.fingerprint = "delivered"
    value.mutate("delivered")
    value.mission.plan = {
      tasks: [
        { ...task, id: "lane", dependencies: [] },
        { ...task, id: "qa", dependencies: ["lane"] },
      ],
    }
    value.mission.tasks = [
      {
        id: "lane",
        reviewerId: "reviewer",
        status: "completed",
        attempts: 1,
        fingerprint: "delivered",
        output: "Lane implemented.",
        review: { passed: true, summary: "Passed.", findings: [] },
      },
      { id: "qa", reviewerId: "reviewer", status: "pending", attempts: 0 },
    ]
    const worker = value.mission.personas.find((persona) => persona.id === "worker")
    if (worker) worker.skills = ["oma-backend"]
    value.mission.goalBrief = brief
    if (value.mission.supervision)
      value.mission.supervision.originalAcceptance = value.mission.plan.tasks.flatMap((entry) => entry.acceptance)
    value.ports.parallel = {
      prepare: vi.fn(async (_mission, taskId, attempt) => record(value.mission, taskId, attempt)),
      integrate: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    }
    value.ports.captureWorkspaceTree = vi.fn(async () => "1".repeat(40))
    value.ports.collectDirectChangeSet = vi.fn(async () => ({
      version: 1 as const,
      inputTree: "1".repeat(40),
      deliveryTree: "2".repeat(40),
      files: [{ path: "tests/lane.test.ts", status: "modified" as const, size: 10, sha256: "3".repeat(64) }],
      diff: "",
      diffTruncated: false,
    }))
    value.ports.integrationCheck = vi.fn(async () => ({ ok: true, output: "ok" }))
    let returnedLookCount = 0
    const base = value.runAgent.getMockImplementation()
    value.runAgent.mockImplementation(async (...args) => {
      const prompt = args[1]
      const stage = args[3]
      if (stage === "supervise" && prompt.includes("what the final wave of this mission returned")) {
        returnedLookCount += 1
        if (returnedLookCount === 1) {
          return JSON.stringify({
            passed: false,
            summary: "QA found an open blocker in lane.",
            findings: ["lane: fix missing disk assertion in tests/lane.test.ts."],
          })
        }
        return passed
      }
      if (stage === "review") return passed
      if (!base) throw new Error("Missing fixture Actor implementation")
      return base(...args)
    })

    const mission = await coordinate(value.mission, value.ports)
    expect(mission.status).toBe("completed")
    expect(value.ports.parallel.prepare).not.toHaveBeenCalled()
    expect(returnedLookCount).toBe(2)
    // First qa run returned early to repair lane before running integrationCheck; then lane + qa each ran once.
    expect(value.ports.integrationCheck).toHaveBeenCalledTimes(2)
    expect(value.runAgent.mock.calls.filter((call) => call[3] === "work").map((call) => call[4]?.taskId)).toEqual([
      "qa",
      "lane",
      "qa",
    ])
  })

  it("carries the findings of a task whose repairs are spent to the task that builds on it", async () => {
    const value = fixture()
    const task = plan.tasks[0]
    if (!task) throw new Error("Expected a fixture task")
    value.mission.maxRepairs = 1
    value.mission.executionPolicy = executionPolicySchema.parse({ maxParallel: 2 })
    value.mission.plan = {
      tasks: [
        { ...task, id: "a" },
        { ...task, id: "b", dependencies: ["a"] },
      ],
    }
    value.mission.tasks = [
      { id: "a", reviewerId: "reviewer", status: "pending", attempts: 1, repairRound: 1 },
      { id: "b", reviewerId: "reviewer", status: "pending", attempts: 0 },
    ]
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
    let reviews = 0
    const base = value.runAgent.getMockImplementation()
    value.runAgent.mockImplementation(async (...args) => {
      if (args[3] === "review") return ++reviews === 1 ? rejected : passed
      if (!base) throw new Error("Missing fixture Actor implementation")
      return base(...args)
    })
    const mission = await coordinate(value.mission, value.ports)
    expect(mission.status).toBe("completed")
    expect(mission.supervision?.decisions).toHaveLength(0)
    expect(value.ports.parallel.prepare).toHaveBeenCalledTimes(1)
    expect(mission.tasks.find((state) => state.id === "a")?.carriedTo).toBe("b")
    expect(mission.plan?.tasks.find((entry) => entry.id === "b")?.acceptance.at(-1)).toContain("Carried from a")
    expect(mission.history.some((event) => event.stage === "task-carried" && event.taskId === "a")).toBe(true)
  })
})
