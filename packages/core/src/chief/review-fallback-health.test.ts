import { describe, expect, it, vi } from "vitest"
import { coordinate } from "./coordinator"
import { createMissionRun } from "./coordinator-run"
import { createMissionContract } from "./coordinator-state"
import { executionPolicySchema } from "./execution"
import { brief, fixture, passed, plan } from "./goal-supervision.fixture"
import { handoffActor, noteReviewerNoVerdict, reviewRouteRetired } from "./handoff"
import { handoffStateSchema } from "./handoff-contract"
import { selectTaskReviewer } from "./review-routing"
import type { ChiefTask, ChiefTaskState, Mission, Persona } from "./types"

function qwenReviewer(): Persona {
  return { id: "review-qwen", name: "Qwen reviewer", role: "Review", agentType: "qwen", skills: [] }
}

/** A single task executed by the codex Chief so the worker vendor is codex. */
function chiefTask(): ChiefTask {
  const task = plan.tasks[0]
  if (!task) throw new Error("Expected a fixture task")
  return { ...task, personaId: "chief" }
}

function missionWithTask(tasks: ChiefTask[] = [chiefTask()]): {
  mission: Mission
  task: ChiefTask
  state: ChiefTaskState
} {
  const value = fixture()
  value.mission.plan = { tasks }
  value.mission.tasks = tasks.map((task) => ({
    id: task.id,
    reviewerId: "review-qwen",
    status: "reviewing",
    attempts: 1,
    output: "work output",
  }))
  value.mission.personas.push(qwenReviewer())
  const task = tasks[0]
  const state = value.mission.tasks[0]
  if (!task || !state) throw new Error("Expected a fixture task")
  return { mission: value.mission, task, state }
}

describe("exhausted-provider review handoff", () => {
  it("prefers a same-vendor roster reviewer over an out-of-roster authenticated CLI under prefer", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({})
    value.mission.operatingPolicy = { reviewVendor: "prefer", memory: false, readyActors: ["codex", "qwen"] }
    value.mission.plan = { tasks: [chiefTask()] }
    value.mission.tasks = [{ id: "onboarding", reviewerId: "review-qwen", status: "reviewing", attempts: 1 }]
    value.mission.personas.push(qwenReviewer())
    value.ports.discoverReadyAgents = vi.fn(async () => ["codex", "qwen", "opencode"])
    const contract = createMissionContract(value.mission)
    const run = createMissionRun(value.mission, value.ports, contract.assert, () => {})
    value.runAgent.mockRejectedValueOnce(new Error("usage_limit_reached")).mockResolvedValue("reviewed")

    expect(await run(qwenReviewer(), "Review", "review", "onboarding")).toBe("reviewed")
    const reviewer = value.runAgent.mock.calls[1]?.[0] as Persona
    expect(reviewer.agentType).toBe("codex")
    expect(reviewer.agentType).not.toBe("opencode")
  })
})

describe("fallback reviewer route health", () => {
  it("retires a route after two no-verdict failures and selects the next same-vendor reviewer", () => {
    const { mission, task, state } = missionWithTask()
    mission.operatingPolicy = { reviewVendor: "prefer", memory: false, readyActors: ["codex", "qwen"] }
    mission.handoff = {
      exhaustedAgents: ["qwen"],
      routes: { "review-qwen": { agentType: "opencode" } },
      continuations: {},
    }
    expect(noteReviewerNoVerdict(mission, "opencode")).toEqual({ retired: false, failures: 1 })
    expect(noteReviewerNoVerdict(mission, "opencode")).toEqual({ retired: true, failures: 2 })
    expect(reviewRouteRetired(mission, "opencode")).toBe(true)
    expect(mission.handoff.routes["review-qwen"]).toBeUndefined()
    handoffStateSchema.parse(mission.handoff)

    const reviewer = selectTaskReviewer(mission, task, state)
    expect(reviewer.agentType).toBe("codex")
    expect(handoffActor(mission, reviewer).agentType).toBe("codex")
  })

  it("re-routes without a Chief recovery round and records a reviewer-fallback event", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({ maxParallel: 1 })
    value.mission.operatingPolicy = { reviewVendor: "prefer", memory: false, readyActors: ["codex", "qwen"] }
    const task = chiefTask()
    value.mission.plan = { tasks: [task] }
    value.mission.tasks = [{ id: task.id, reviewerId: "review-qwen", status: "reviewing", attempts: 1, output: "work" }]
    value.mission.personas.push(qwenReviewer())
    value.mission.goalBrief = brief
    value.mission.initialFingerprint = "baseline"
    if (value.mission.supervision) value.mission.supervision.originalAcceptance = task.acceptance
    value.mission.handoff = {
      exhaustedAgents: ["qwen"],
      routes: { "review-codex": { agentType: "opencode" } },
      continuations: {},
    }
    const base = value.runAgent.getMockImplementation()
    const supervise = vi.fn(async () => "{}")
    value.runAgent.mockImplementation(async (...args) => {
      if (args[3] === "review") {
        if (args[0].agentType === "opencode")
          throw new Error("opencode fallback exited before readiness without a verdict")
        return passed
      }
      if (args[3] === "supervise") return supervise()
      return (await base?.(...args)) ?? ""
    })
    value.verify.mockImplementation(async () => ({ ok: true, output: "verified" }))

    const result = await coordinate(value.mission, value.ports)

    expect(result.status).toBe("completed")
    expect(supervise).not.toHaveBeenCalled()
    expect(result.tasks[0]?.status).toBe("completed")
    expect(result.handoff?.retiredReviewRoutes).toContain("opencode")
    const fallback = result.history.find((event) => event.stage === "reviewer-fallback")
    expect(fallback?.message).toContain("opencode")
    expect(fallback?.message).toContain("codex")
    expect(
      value.runAgent.mock.calls.filter((call) => call[3] === "review" && call[0].agentType === "opencode"),
    ).toHaveLength(2)
  })

  it("still refuses same-vendor review in require mode", () => {
    const { mission, task, state } = missionWithTask()
    mission.operatingPolicy = { reviewVendor: "require", memory: false, readyActors: ["codex"] }
    const requireState = { ...state, reviewerId: "reviewer" }
    expect(() => selectTaskReviewer(mission, task, requireState)).toThrow("Cross-vendor review is required")
  })
})
