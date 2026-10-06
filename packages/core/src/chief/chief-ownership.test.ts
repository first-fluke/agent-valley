import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { coordinate } from "./coordinator"
import { chiefRecoveryStopped, executionPolicySchema, executionState } from "./execution"
import { brief, fixture, plan, rejected } from "./goal-supervision.fixture"
import { missionSchema, parseSupervisionResponse, validateMission } from "./schemas"
import { MissionStore } from "./store"

const now = Date.parse("2026-10-03T10:00:00Z")
const task = plan.tasks[0]
if (!task) throw new Error("Expected onboarding fixture")
const calls = (value: ReturnType<typeof fixture>, stage: string) =>
  value.runAgent.mock.calls.filter((call) => call[3] === stage)
const wait = JSON.stringify({
  action: "wait",
  reason: "Wait for fresh source evidence before continuing the original goal.",
  retryAfterSec: 30,
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
})
afterEach(() => vi.useRealTimers())

describe("Chief owns mission recovery", () => {
  it("joins parallel Actors before sending unavailable source evidence to Chief instead of consuming local repairs", async () => {
    const value = fixture()
    value.mission.maxRepairs = 2
    value.mission.executionPolicy = executionPolicySchema.parse({ maxParallel: 2 })
    const base = value.runAgent.getMockImplementation()
    const settled = new Set<string>()
    value.ports.parallel = {
      prepare: async (mission, taskId, attempt) => ({
        version: 1,
        missionId: mission.id,
        taskId,
        attempt,
        sourceWorkspacePath: mission.workspace.path,
        path: `/private/${taskId}`,
        branch: `av-task/${taskId}`,
        baselineHead: "a".repeat(40),
        baselineTree: "b".repeat(40),
      }),
      integrate: async () => {},
      dispose: async () => {},
    }
    value.runAgent.mockImplementation(async (...args) => {
      if (args[3] === "plan") return JSON.stringify({ goalBrief: brief, tasks: [task, { ...task, id: "source-task" }] })
      if (args[3] === "work") {
        settled.add(args[4]?.taskId ?? "")
        if (args[4]?.taskId === "source-task") throw new Error("HTTP 401 source token unavailable")
      }
      if (args[3] === "supervise") {
        expect([...settled].sort()).toEqual([task.id, "source-task"].sort())
        expect(args[1]).toContain("HTTP 401 source token unavailable")
        return wait
      }
      return (await base?.(...args)) ?? ""
    })
    expect((await coordinate(value.mission, value.ports)).status).toBe("waiting")
    expect(calls(value, "work")).toHaveLength(2)
    expect(calls(value, "supervise")).toHaveLength(1)
    expect(value.mission.tasks.find((state) => state.id === task.id)?.status).toBe("completed")
    expect(value.mission.tasks.find((state) => state.id === "source-task")?.repairRound).toBeUndefined()
    expect(value.mission.execution?.retries).toBe(0)
  })

  it.each(["HTTP 401 expired token", "ENOENT worker CLI missing"])(
    "reassigns after %s using the selected Chief and preserving spent counters",
    async (reason) => {
      const value = fixture()
      value.mission.executionPolicy = executionPolicySchema.parse({ maxParallel: 1 })
      executionState(value.mission).retries = 2
      const base = value.runAgent.getMockImplementation()
      let failed = false
      value.runAgent.mockImplementation(async (...args) => {
        if (args[3] === "work" && !failed) {
          failed = true
          throw new Error(reason)
        }
        if (args[3] === "supervise") {
          expect(args[0]).toMatchObject({ id: "chief", agentType: "codex", model: "operator-model" })
          expect(args[1]).toContain(reason)
          return JSON.stringify({
            action: "reassign",
            reason: "Use the available authorized Actor.",
            taskId: task.id,
            personaId: "reviewer",
            instructions: "Complete the same acceptance checks with the available Actor.",
          })
        }
        return (await base?.(...args)) ?? ""
      })
      expect((await coordinate(value.mission, value.ports)).status).toBe("completed")
      expect(calls(value, "work").map((call) => call[0].id)).toEqual(["worker", "reviewer"])
      expect(value.mission.execution?.retries).toBe(2)
      expect(value.mission.execution?.runsStarted).toBe(value.runAgent.mock.calls.length)
      expect(value.mission.goal).toBe("Make this app easy to start using")
      expect(value.mission.supervision?.originalAcceptance).toEqual(task.acceptance)
    },
  )

  it("persists Chief wait through real save/load and makes no calls on early resume", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({ maxParallel: 1, maxRetries: 2 })
    executionState(value.mission).retries = 2
    const directory = await mkdtemp(join(tmpdir(), "av-chief-wait-"))
    try {
      const store = new MissionStore(directory)
      value.ports.save = (mission) => store.save(mission)
      const base = value.runAgent.getMockImplementation()
      let failed = false
      value.runAgent.mockImplementation(async (...args) => {
        if (args[3] === "work" && !failed) {
          failed = true
          throw new Error("HTTP 503 provider unavailable")
        }
        if (args[3] === "supervise") return wait
        return (await base?.(...args)) ?? ""
      })
      await coordinate(value.mission, value.ports)
      const restored = await store.load(value.mission.id)
      expect(restored).toMatchObject({
        status: "waiting",
        execution: {
          failureKind: "chief-wait",
          nextRunAt: new Date(now + 30_000).toISOString(),
          retries: 2,
          runsStarted: 3,
        },
      })
      expect(restored.supervision?.decisions.at(-1)).toMatchObject({ action: "wait", retryAfterSec: 30 })
      expect(restored.supervision?.stalledRounds).toBe(0)
      const early = structuredClone(restored)
      value.runAgent.mockClear()
      await coordinate(restored, value.ports)
      expect(restored).toEqual(early)
      expect(value.runAgent).not.toHaveBeenCalled()
      vi.advanceTimersByTime(30_000)
      expect((await coordinate(restored, value.ports)).status).toBe("completed")
      expect(calls(value, "work")).toHaveLength(1)
      expect(calls(value, "supervise")).toHaveLength(0)
      expect(calls(value, "plan")).toHaveLength(0)
      expect(restored.execution).toMatchObject({ retries: 2, runsStarted: 7, startedAt: new Date(now).toISOString() })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("retains genuine unknown effects while Chief waits and stops without replay", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({ maxParallel: 1 })
    const base = value.runAgent.getMockImplementation()
    let decisions = 0
    value.runAgent.mockImplementation(async (...args) => {
      if (args[3] === "plan")
        return JSON.stringify({ ...plan, goalBrief: brief, tasks: [{ ...task, effectScope: "external" }] })
      if (args[3] === "work") throw new Error("Connection lost after remote acceptance; outcome unknown")
      if (args[3] === "supervise") {
        expect(args[1]).toContain('"effectState":"unknown"')
        return decisions++ === 0
          ? wait
          : JSON.stringify({
              action: "stop",
              reason: "No trustworthy destination proof establishes the action outcome.",
            })
      }
      return (await base?.(...args)) ?? ""
    })
    expect((await coordinate(value.mission, value.ports)).status).toBe("waiting")
    expect(value.mission.tasks[0]?.effectState).toBe("unknown")
    expect(value.mission.supervision?.pendingRecovery?.taskId).toBe(task.id)
    await coordinate(value.mission, value.ports)
    expect(calls(value, "work")).toHaveLength(1)
    expect(calls(value, "supervise")).toHaveLength(1)
    vi.advanceTimersByTime(30_000)
    await expect(coordinate(value.mission, value.ports)).rejects.toThrow("Chief Director stopped")
    expect(value.mission.tasks[0]?.effectState).toBe("unknown")
    expect(calls(value, "work")).toHaveLength(1)
    expect(value.mission.execution?.retries).toBe(0)
    expect(value.mission.report?.summary).toContain("미완료")
    expect(value.mission.error).not.toContain("--resolve-effect")
  })

  it("can add a repair after completed external action review fails without replaying that action", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({ maxParallel: 1 })
    const base = value.runAgent.getMockImplementation()
    let reviewed = false
    value.runAgent.mockImplementation(async (...args) => {
      if (args[3] === "plan")
        return JSON.stringify({ ...plan, goalBrief: brief, tasks: [{ ...task, effectScope: "external" }] })
      if (args[3] === "review" && args[4]?.taskId === task.id && !reviewed) {
        reviewed = true
        return rejected
      }
      if (args[3] === "supervise") {
        expect(args[1]).toContain('"effectState":"completed"')
        return JSON.stringify({
          action: "replan",
          reason: "Keep the finished publication and fix its local content before reinspection.",
          tasks: [
            { ...task, effectScope: "external", dependencies: ["fix-content"] },
            { ...task, id: "fix-content", effectScope: "workspace" },
          ],
        })
      }
      return (await base?.(...args)) ?? ""
    })
    expect((await coordinate(value.mission, value.ports)).status).toBe("completed")
    expect(calls(value, "work").map((call) => call[4]?.taskId)).toEqual([task.id, "fix-content"])
    expect(value.mission.tasks.find((state) => state.id === task.id)?.effectState).toBe("completed")
    expect(value.mission.supervision?.decisions[0]?.previousTasks?.[0]?.effectState).toBe("completed")
  })

  it("does not count scheduled unknown-effect waits as stalled product repairs, but retains the round limit", async () => {
    const value = fixture()
    if (value.mission.supervision) value.mission.supervision.maxRounds = 3
    const base = value.runAgent.getMockImplementation()
    value.runAgent.mockImplementation(async (...args) => {
      if (args[3] === "plan") return JSON.stringify({ goalBrief: brief, tasks: [{ ...task, effectScope: "external" }] })
      if (args[3] === "work") throw new Error("Remote action outcome unavailable")
      if (args[3] === "supervise") return wait
      return (await base?.(...args)) ?? ""
    })
    for (let round = 1; round <= 3; round++) {
      expect((await coordinate(value.mission, value.ports)).status).toBe("waiting")
      expect(value.mission.supervision?.rounds).toBe(round)
      expect(value.mission.supervision?.stalledRounds).toBe(0)
      vi.advanceTimersByTime(30_000)
    }
    expect((await coordinate(value.mission, value.ports)).execution?.failureKind).toBe("budget")
    expect(calls(value, "work")).toHaveLength(1)
    expect(calls(value, "supervise")).toHaveLength(3)
    expect(value.mission.tasks[0]?.effectState).toBe("unknown")
  })
})

describe("strict Chief decisions and durable stop", () => {
  it.each([0, 86_401, 1.5, "30"])("rejects wait delay %s", (retryAfterSec) => {
    expect(() =>
      parseSupervisionResponse(
        JSON.stringify({ action: "wait", reason: "Wait for evidence", retryAfterSec }),
        fixture().mission,
      ),
    ).toThrow()
  })

  it("validates saved wait identity and refuses invented repairs for unknown effects", async () => {
    const value = fixture()
    value.mission.plan = plan
    value.mission.goalBrief = brief
    if (value.mission.supervision) value.mission.supervision.originalAcceptance = task.acceptance
    value.mission.tasks = [
      { id: task.id, reviewerId: "reviewer", status: "pending", attempts: 1, effectState: "unknown" },
    ]
    expect(() =>
      parseSupervisionResponse(
        JSON.stringify({ action: "repair", reason: "Try again", instructions: "Repeat publication" }),
        value.mission,
      ),
    ).toThrow("may only wait or stop")
    value.mission.supervision?.decisions.push({
      round: 1,
      at: new Date(now).toISOString(),
      action: "wait",
      reason: "Wait for evidence",
      retryAfterSec: 30,
      fingerprint: "initial",
    })
    if (value.mission.supervision) value.mission.supervision.rounds = 1
    value.mission.execution = {
      startedAt: new Date(now).toISOString(),
      runsStarted: 1,
      retries: 0,
      failureKind: "chief-wait",
      nextRunAt: new Date(now + 1_000).toISOString(),
    }
    expect(() => validateMission(value.mission)).toThrow("wait schedule")
  })

  it.each([
    { action: "wait", retryAfterSec: undefined },
    { action: "stop", retryAfterSec: 30 },
    { action: "wait", retryAfterSec: 86_401 },
  ])("rejects a malformed durable decision %j at store-schema boundary", (decision) => {
    const { mission } = fixture()
    mission.supervision?.decisions.push({
      round: 1,
      at: new Date(now).toISOString(),
      action: decision.action as "wait" | "stop",
      reason: "Saved decision",
      fingerprint: "initial",
      ...(decision.retryAfterSec !== undefined ? { retryAfterSec: decision.retryAfterSec } : {}),
    })
    expect(() => missionSchema.parse(mission)).toThrow()
  })

  it("uses strict chronological intervention timestamps and fails closed on invalid stop dates", () => {
    const { mission } = fixture()
    mission.supervision?.decisions.push({
      round: 1,
      action: "stop",
      reason: "No evidence",
      fingerprint: "initial",
      at: new Date(now).toISOString(),
    })
    expect(chiefRecoveryStopped(mission)).toBe(true)
    executionState(mission).interventionAt = new Date(now + 1_000).toISOString()
    expect(chiefRecoveryStopped(mission)).toBe(false)
    executionState(mission).interventionAt = "invalid"
    expect(chiefRecoveryStopped(mission)).toBe(true)
  })
})
