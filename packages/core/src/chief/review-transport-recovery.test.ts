import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ACTOR_COOLDOWN_BASE_MS } from "./actor-health"
import { coordinate } from "./coordinator"
import { executionPolicySchema } from "./execution"
import { brief, fixture, plan, rejected } from "./goal-supervision.fixture"
import type { OperatingRun } from "./operations"
import { applyRecovery } from "./supervision"
import type { ChiefStage, Mission, Persona } from "./types"

const now = Date.parse("2026-11-09T00:00:00Z")
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
})
afterEach(() => vi.useRealTimers())

function recordRun(mission: Mission, actor: Persona, stage: ChiefStage, taskId: string, outcome: "passed" | "failed") {
  mission.operations ??= { runs: [], routingEvidence: [], reviewDecisions: [] }
  const run: OperatingRun = {
    runId: `${stage}-${mission.operations.runs.length}`,
    stage,
    taskId,
    actorId: actor.id,
    actorType: actor.agentType,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedMs: 10,
    inputTokens: 10,
    outputTokens: 10,
    costUsd: 0.01,
    outcome,
    executionState: "settled",
  }
  mission.operations.runs.push(run)
  return run
}

describe("native review failures preserve successful work", () => {
  it.each([false, true])("resumes only the review after a provider failure (external=%s)", async (external) => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({ retryDelayMs: 1_000 })
    const base = value.runAgent.getMockImplementation()
    let failed = false
    value.runAgent.mockImplementation(async (...args) => {
      const [actor, , mission, stage, context] = args
      if (stage === "plan" && external)
        return JSON.stringify({
          ...plan,
          goalBrief: brief,
          tasks: plan.tasks.map((task) => ({ ...task, effectScope: "external" })),
        })
      if (stage === "work") recordRun(mission, actor, stage, context?.taskId ?? "onboarding", "passed")
      if (stage === "review" && !failed) {
        failed = true
        const taskId = context?.taskId ?? "onboarding"
        recordRun(mission, actor, stage, taskId, "failed")
        mission.operations?.reviewDecisions.push({
          taskId,
          workerActorType: "cursor",
          reviewerId: actor.id,
          reviewerActorType: actor.agentType,
          crossVendor: true,
          outcome: "assigned",
          reason: "Independent native review",
        })
        throw new Error("HTTP 503 reviewer temporarily unavailable")
      }
      return (await base?.(...args)) ?? ""
    })
    expect((await coordinate(value.mission, value.ports)).status).toBe("waiting")
    const work = value.mission.operations?.runs.find((run) => run.stage === "work")
    expect(work?.outcome).toBe("passed")
    expect(work?.evidence).toBeUndefined()
    expect(value.mission.operations?.reviewDecisions.at(-1)?.outcome).toBe("failed")
    expect(value.mission.tasks[0]).toMatchObject({
      attempts: 1,
      output: expect.stringContaining("Changed onboarding.ts"),
    })
    expect(value.mission.tasks[0]?.review).toBeUndefined()
    expect(value.mission.tasks[0]?.repairRound ?? 0).toBe(0)
    const saved = structuredClone(value.snapshots.at(-1) as Mission)
    vi.advanceTimersByTime(1_000)
    const calls = value.runAgent.mock.calls.length
    expect((await coordinate(saved, value.ports)).status).toBe("waiting")
    expect(value.runAgent).toHaveBeenCalledTimes(calls)
    expect(saved.execution?.failureKind).toBe("actor-cooldown")
    vi.advanceTimersByTime(ACTOR_COOLDOWN_BASE_MS - 1_000)
    expect((await coordinate(saved, value.ports)).status).toBe("completed")
    expect(value.runAgent.mock.calls.filter((call) => call[3] === "work")).toHaveLength(1)
    expect(value.runAgent.mock.calls.filter((call) => call[3] === "review")).toHaveLength(2)
    expect(saved.tasks[0]?.attempts).toBe(1)
    expect(saved.execution?.runsStarted).toBe(value.runAgent.mock.calls.length)
    expect(saved.execution?.retries).toBe(1)
  })

  it("preserves pending-review output through a bounded Chief wait without rerunning the worker", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({ maxRetries: 0 })
    const base = value.runAgent.getMockImplementation()
    let failed = false
    value.runAgent.mockImplementation(async (...args) => {
      if (args[3] === "work") recordRun(args[2], args[0], "work", args[4]?.taskId ?? "onboarding", "passed")
      if (args[3] === "review" && !failed) {
        failed = true
        throw new Error("Reviewer protocol connection closed")
      }
      if (args[3] === "supervise")
        return JSON.stringify({ action: "wait", reason: "Wait for reviewer connectivity", retryAfterSec: 1 })
      return (await base?.(...args)) ?? ""
    })
    expect((await coordinate(value.mission, value.ports)).status).toBe("waiting")
    vi.advanceTimersByTime(1_000)
    expect((await coordinate(value.mission, value.ports)).status).toBe("completed")
    expect(value.runAgent.mock.calls.filter((call) => call[3] === "supervise")).toHaveLength(1)
    expect(value.runAgent.mock.calls.filter((call) => call[3] === "work")).toHaveLength(1)
    expect(value.mission.tasks[0]?.attempts).toBe(1)
    expect(value.mission.tasks[0]?.repairRound ?? 0).toBe(0)
  })

  it("re-reviews an unchanged approved sibling while fresh work runs only for the Chief's changed task", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({ maxParallel: 1, maxRetries: 0 })
    const task = plan.tasks[0]
    if (!task) throw new Error("Expected fixture task")
    const tasks = ["a", "b"].map((id) => ({ ...task, id, title: id, acceptance: [`Verified ${id}`] }))
    const base = value.runAgent.getMockImplementation()
    let failed = false
    value.runAgent.mockImplementation(async (...args) => {
      if (args[3] === "plan") return JSON.stringify({ tasks, goalBrief: brief })
      if (args[3] === "work") recordRun(args[2], args[0], "work", args[4]?.taskId ?? "", "passed")
      if (args[3] === "review" && args[4]?.taskId === "b" && !failed) {
        failed = true
        throw new Error("Reviewer protocol connection closed")
      }
      return (await base?.(...args)) ?? ""
    })
    expect((await coordinate(value.mission, value.ports)).status).toBe("completed")
    const work = value.runAgent.mock.calls.filter((call) => call[3] === "work")
    expect(work.filter((call) => call[4]?.taskId === "a")).toHaveLength(1)
    expect(work.filter((call) => call[4]?.taskId === "b")).toHaveLength(2)
    expect(value.runAgent.mock.calls.filter((call) => call[3] === "review" && call[4]?.taskId === "a")).toHaveLength(2)
    expect(
      value.mission.operations?.runs.filter((run) => run.stage === "work").every((run) => run.outcome === "passed"),
    ).toBe(true)
  })

  it.each(["instructions", "persona", "acceptance", "dependencies"])(
    "invalidates pending-review output when replanning changes %s",
    (field) => {
      const value = fixture()
      value.mission.plan = structuredClone(plan)
      value.mission.tasks = [
        {
          id: "onboarding",
          reviewerId: "reviewer",
          status: "reviewing",
          attempts: 2,
          repairRound: 1,
          output: "Old work waiting for review",
        },
      ]
      const tasks = structuredClone(plan.tasks)
      const task = tasks[0]
      if (!task) throw new Error("Expected fixture task")
      if (field === "instructions") task.instructions = "Implement a newly specified behavior"
      if (field === "persona") task.personaId = "chief"
      if (field === "acceptance") task.acceptance.push("New acceptance obligation")
      if (field === "dependencies") task.dependencies.push("new-prerequisite")
      applyRecovery(value.mission, { action: "replan", reason: "Changed assignment", tasks })
      expect(value.mission.tasks[0]).toMatchObject({ status: "pending", attempts: 2, repairRound: 1 })
      expect(value.mission.tasks[0]?.output).toBeUndefined()
    },
  )

  it("reviews main-worktree output before a replan's new parallel wave can replace it", async () => {
    const value = fixture()
    const task = plan.tasks[0]
    if (!task) throw new Error("Expected fixture task")
    value.mission.executionPolicy = executionPolicySchema.parse({ maxParallel: 2 })
    value.mission.plan = {
      tasks: [
        { ...task, id: "a" },
        { ...task, id: "b" },
      ],
    }
    value.mission.tasks = [
      {
        id: "a",
        reviewerId: "reviewer",
        status: "reviewing",
        attempts: 1,
        output: "Serial output already present in the mission worktree",
      },
      { id: "b", reviewerId: "reviewer", status: "pending", attempts: 0 },
    ]
    value.mission.goalBrief = brief
    if (value.mission.supervision)
      value.mission.supervision.originalAcceptance = value.mission.plan.tasks.flatMap((entry) => entry.acceptance)
    value.ports.parallel = { prepare: vi.fn(), integrate: vi.fn(), dispose: vi.fn() }
    expect((await coordinate(value.mission, value.ports)).status).toBe("completed")
    expect(value.runAgent.mock.calls.filter((call) => call[3] === "work").map((call) => call[4]?.taskId)).toEqual(["b"])
    expect(value.ports.parallel.prepare).not.toHaveBeenCalled()
    expect(value.mission.tasks.find((state) => state.id === "a")?.attempts).toBe(1)
  })

  it("retains an unchanged private delivery after resume normalized its pending-review status", () => {
    const value = fixture()
    value.mission.plan = structuredClone(plan)
    const parallel = {
      version: 1 as const,
      missionId: value.mission.id,
      taskId: "onboarding",
      attempt: 2,
      sourceWorkspacePath: value.mission.workspace.path,
      path: "/private/task",
      branch: "task/onboarding",
      baselineHead: "a".repeat(40),
      baselineTree: "b".repeat(40),
    }
    value.mission.tasks = [
      {
        id: "onboarding",
        reviewerId: "reviewer",
        status: "pending",
        attempts: 2,
        repairRound: 1,
        output: "Successful private output",
        parallel,
      },
    ]
    if (value.mission.supervision)
      value.mission.supervision.pendingRecovery = {
        taskId: "onboarding",
        reason: "The independent reviewer returned no verdict",
      }
    applyRecovery(value.mission, {
      action: "replan",
      reason: "Retry independent review",
      tasks: structuredClone(plan.tasks),
    })
    expect(value.mission.tasks[0]).toMatchObject({
      status: "reviewing",
      attempts: 2,
      repairRound: 1,
      output: "Successful private output",
      parallel,
    })
    expect(value.mission.tasks[0]?.review).toBeUndefined()
  })

  it("refreshes an approved parallel sibling from the main worktree after its private workspace was disposed", () => {
    const value = fixture()
    const task = plan.tasks[0]
    if (!task) throw new Error("Expected fixture task")
    value.mission.plan = {
      tasks: [
        { ...task, id: "a" },
        { ...task, id: "b" },
      ],
    }
    value.mission.tasks = [
      {
        id: "a",
        reviewerId: "reviewer",
        status: "completed",
        attempts: 1,
        output: "Approved integrated output",
        review: { passed: true, summary: "Passed", findings: [] },
        parallel: {
          version: 1,
          missionId: value.mission.id,
          taskId: "a",
          attempt: 1,
          sourceWorkspacePath: value.mission.workspace.path,
          path: "/disposed/task-a",
          branch: "task/a",
          baselineHead: "a".repeat(40),
          baselineTree: "b".repeat(40),
        },
      },
      { id: "b", reviewerId: "reviewer", status: "pending", attempts: 1, output: "Work waiting for a reviewer" },
    ]
    if (value.mission.supervision)
      value.mission.supervision.pendingRecovery = { taskId: "b", reason: "Reviewer returned no verdict" }
    applyRecovery(value.mission, {
      action: "replan",
      reason: "Retry reviewer",
      tasks: structuredClone(value.mission.plan.tasks),
    })
    expect(value.mission.tasks[0]).toMatchObject({
      status: "reviewing",
      attempts: 1,
      output: "Approved integrated output",
    })
    expect(value.mission.tasks[0]?.parallel).toBeUndefined()
    expect(value.mission.tasks[0]?.review).toBeUndefined()
  })

  it("preserves completed sibling work when the interrupted task never produced output", () => {
    const value = fixture()
    const task = plan.tasks[0]
    if (!task) throw new Error("Expected fixture task")
    value.mission.plan = {
      tasks: [
        { ...task, id: "a" },
        { ...task, id: "b" },
      ],
    }
    value.mission.tasks = [
      {
        id: "a",
        reviewerId: "reviewer",
        status: "completed",
        attempts: 1,
        output: "Approved integrated output",
        review: { passed: true, summary: "Passed", findings: [] },
        fingerprint: "verified-fingerprint",
      },
      { id: "b", reviewerId: "reviewer", status: "pending", attempts: 1 },
    ]
    if (value.mission.supervision)
      value.mission.supervision.pendingRecovery = { taskId: "b", reason: "Actor dispatch failed before any output" }
    applyRecovery(value.mission, {
      action: "repair",
      reason: "Retry the failed dispatch",
      taskId: "b",
      instructions: "Use an installed skill and complete the assignment.",
    })
    expect(value.mission.tasks[0]).toMatchObject({
      status: "reviewing",
      attempts: 1,
      output: "Approved integrated output",
    })
    expect(value.mission.tasks[0]?.review).toBeUndefined()
    expect(value.mission.tasks[1]?.status).toBe("pending")
  })

  it("does not rerun completed sibling work after a dispatch failure with no output", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({ maxParallel: 1, maxRetries: 0 })
    const task = plan.tasks[0]
    if (!task) throw new Error("Expected fixture task")
    const tasks = ["a", "b"].map((id) => ({ ...task, id, title: id, acceptance: [`Verified ${id}`] }))
    const base = value.runAgent.getMockImplementation()
    let failed = false
    value.runAgent.mockImplementation(async (...args) => {
      if (args[3] === "plan") return JSON.stringify({ tasks, goalBrief: brief })
      if (args[3] === "work") {
        if (args[4]?.taskId === "b" && !failed) {
          failed = true
          throw new Error("OMA skill oma-coordination is missing from the installed catalog")
        }
        recordRun(args[2], args[0], "work", args[4]?.taskId ?? "", "passed")
      }
      if (args[3] === "supervise")
        return JSON.stringify({
          action: "repair",
          reason: "Retry the failed dispatch with an installed skill.",
          taskId: "b",
          instructions: "Complete the assignment with the installed skill.",
        })
      return (await base?.(...args)) ?? ""
    })
    expect((await coordinate(value.mission, value.ports)).status).toBe("completed")
    const work = value.runAgent.mock.calls.filter((call) => call[3] === "work")
    expect(work.filter((call) => call[4]?.taskId === "a")).toHaveLength(1)
    expect(work.filter((call) => call[4]?.taskId === "b")).toHaveLength(2)
    expect(value.mission.tasks.find((state) => state.id === "a")?.attempts).toBe(1)
  })

  it.each([false, true])("integrates retained private output before serial review (conflict=%s)", async (conflict) => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({ maxParallel: 1 })
    value.mission.plan = structuredClone(plan)
    value.mission.goalBrief = brief
    delete value.mission.supervision
    value.mission.tasks = [
      {
        id: "onboarding",
        reviewerId: "reviewer",
        status: "pending",
        attempts: 1,
        output: "Successful private output",
        parallel: {
          version: 1,
          missionId: value.mission.id,
          taskId: "onboarding",
          attempt: 1,
          sourceWorkspacePath: value.mission.workspace.path,
          path: "/private/task",
          branch: "task/onboarding",
          baselineHead: "a".repeat(40),
          baselineTree: "b".repeat(40),
        },
      },
    ]
    const worker = value.mission.personas.find((actor) => actor.id === "worker")
    if (!worker) throw new Error("Expected fixture worker")
    const work = recordRun(value.mission, worker, "work", "onboarding", "passed")
    let integrated = false
    value.ports.parallel = {
      prepare: vi.fn(),
      integrate: vi.fn(async () => {
        if (conflict) throw new Error("Actual private patch could not integrate")
        integrated = true
        value.mutate("integrated-private-delivery")
      }),
      dispose: vi.fn(),
    }
    const base = value.runAgent.getMockImplementation()
    value.runAgent.mockImplementation(async (...args) => {
      if (args[3] === "review") expect(integrated).toBe(true)
      return (await base?.(...args)) ?? ""
    })
    if (conflict) {
      await expect(coordinate(value.mission, value.ports)).rejects.toThrow("could not integrate")
      expect(value.runAgent.mock.calls.filter((call) => call[3] === "review")).toHaveLength(0)
    } else expect((await coordinate(value.mission, value.ports)).status).toBe("completed")
    expect(value.runAgent.mock.calls.filter((call) => call[3] === "work")).toHaveLength(0)
    expect(work.outcome).toBe("passed")
    expect(value.ports.parallel.integrate).toHaveBeenCalledOnce()
  })

  it("blocks an uncertain reviewer execution without rejecting or replaying successful work", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({})
    const base = value.runAgent.getMockImplementation()
    value.runAgent.mockImplementation(async (...args) => {
      if (args[3] === "work") recordRun(args[2], args[0], "work", args[4]?.taskId ?? "onboarding", "passed")
      if (args[3] === "review") {
        recordRun(args[2], args[0], "review", args[4]?.taskId ?? "onboarding", "failed").executionState = "unknown"
        throw new Error("Reviewer cleanup has no confirmed termination")
      }
      return (await base?.(...args)) ?? ""
    })
    expect((await coordinate(value.mission, value.ports)).status).toBe("paused")
    expect(value.mission.execution?.failureKind).toBe("unknown-effect")
    expect(value.mission.operations?.runs.find((run) => run.stage === "work")?.outcome).toBe("passed")
    const count = value.runAgent.mock.calls.length
    expect((await coordinate(value.mission, value.ports)).status).toBe("paused")
    expect(value.runAgent).toHaveBeenCalledTimes(count)
  })

  it("still rejects and repairs work when the reviewer returns actual negative findings", async () => {
    const value = fixture()
    value.mission.maxRepairs = 1
    value.mission.executionPolicy = executionPolicySchema.parse({})
    const base = value.runAgent.getMockImplementation()
    let reviews = 0
    value.runAgent.mockImplementation(async (...args) => {
      if (args[3] === "work") recordRun(args[2], args[0], "work", args[4]?.taskId ?? "onboarding", "passed")
      if (args[3] === "review" && ++reviews === 1) return rejected
      return (await base?.(...args)) ?? ""
    })
    expect((await coordinate(value.mission, value.ports)).status).toBe("completed")
    expect(value.runAgent.mock.calls.filter((call) => call[3] === "work")).toHaveLength(2)
    expect(value.mission.operations?.runs.filter((run) => run.stage === "work").map((run) => run.outcome)).toEqual([
      "rejected",
      "passed",
    ])
    expect(value.mission.tasks[0]).toMatchObject({ attempts: 2, repairRound: 1 })
  })

  it("retries parallel review without another worker call or workspace preparation", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({ maxParallel: 2, retryDelayMs: 1_000 })
    const task = plan.tasks[0]
    if (!task) throw new Error("Expected fixture task")
    const tasks = ["a", "b"].map((id) => ({ ...task, id, title: id, acceptance: [`Verified ${id}`] }))
    const base = value.runAgent.getMockImplementation()
    let failed = false
    value.runAgent.mockImplementation(async (...args) => {
      const [actor, , mission, stage, context] = args
      if (stage === "plan") return JSON.stringify({ tasks, goalBrief: brief })
      if (stage === "work") recordRun(mission, actor, stage, context?.taskId ?? "", "passed")
      if (stage === "review" && context?.taskId === "a" && !failed) {
        failed = true
        recordRun(mission, actor, stage, "a", "failed")
        throw new Error("HTTP 503 reviewer temporarily unavailable")
      }
      return (await base?.(...args)) ?? ""
    })
    const parallel: NonNullable<typeof value.ports.parallel> = {
      prepare: vi.fn(async (mission, taskId, attempt) => ({
        version: 1 as const,
        missionId: mission.id,
        taskId,
        attempt,
        sourceWorkspacePath: mission.workspace.path,
        path: `/private/task-${taskId}`,
        branch: `task/${taskId}`,
        baselineHead: "a".repeat(40),
        baselineTree: "b".repeat(40),
      })),
      integrate: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    }
    value.ports.parallel = parallel
    expect((await coordinate(value.mission, value.ports)).status).toBe("waiting")
    expect(value.mission.operations?.runs.filter((run) => run.stage === "work").map((run) => run.outcome)).toEqual([
      "passed",
      "passed",
    ])
    expect(value.mission.tasks.find((state) => state.id === "a")?.parallel).toBeDefined()
    vi.advanceTimersByTime(1_000)
    const calls = value.runAgent.mock.calls.length
    expect((await coordinate(value.mission, value.ports)).status).toBe("waiting")
    expect(value.runAgent).toHaveBeenCalledTimes(calls)
    vi.advanceTimersByTime(ACTOR_COOLDOWN_BASE_MS - 1_000)
    expect((await coordinate(value.mission, value.ports)).status).toBe("completed")
    expect(value.runAgent.mock.calls.filter((call) => call[3] === "work")).toHaveLength(2)
    expect(parallel.prepare).toHaveBeenCalledTimes(2)
    expect(value.mission.tasks.every((state) => state.attempts === 1 && !state.repairRound)).toBe(true)
  })
})
