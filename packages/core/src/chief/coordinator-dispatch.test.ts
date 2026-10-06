import { describe, expect, it } from "vitest"
import { coordinate } from "./coordinator"
import { CheckpointError, createMissionRun } from "./coordinator-run"
import { executionPolicySchema, executionState, MissionPause } from "./execution"
import { brief, fixture, plan } from "./goal-supervision.fixture"

const task =
  plan.tasks[0] ??
  (() => {
    throw new Error("Expected onboarding fixture")
  })()
function externalFixture() {
  const value = fixture()
  value.mission.executionPolicy = executionPolicySchema.parse({ maxParallel: 1 })
  value.mission.plan = { tasks: [{ ...task, effectScope: "external" }] }
  value.mission.goalBrief = brief
  if (value.mission.supervision) value.mission.supervision.originalAcceptance = task.acceptance
  value.mission.tasks = [
    { id: task.id, reviewerId: "reviewer", status: "pending", attempts: 0, effectState: "not-started" },
  ]
  const actor = value.mission.personas.find((entry) => entry.id === "worker")
  if (!actor) throw new Error("Expected worker Actor")
  return { ...value, actor }
}

describe("external dispatch checkpoints", () => {
  it("does not mark an external effect uncertain when its Actor budget prevents invocation", async () => {
    const value = externalFixture()
    if (value.mission.executionPolicy) value.mission.executionPolicy.maxRuns = 1
    executionState(value.mission).runsStarted = 1
    expect((await coordinate(value.mission, value.ports)).status).toBe("paused")
    expect(value.mission.execution?.failureKind).toBe("budget")
    expect(value.mission.tasks[0]?.effectState).toBe("not-started")
    expect(value.runAgent).not.toHaveBeenCalled()
    expect(value.snapshots.at(-1)?.tasks[0]?.effectState).toBe("not-started")
  })

  it.each(["budget-save", "fingerprint", "effect-save"] as const)(
    "preserves a known not-started effect when %s fails before dispatch",
    async (boundary) => {
      const value = externalFixture()
      if (boundary === "budget-save")
        value.ports.save = async () => {
          throw new Error("Storage unavailable")
        }
      if (boundary === "fingerprint")
        value.ports.fingerprint = async () => {
          throw new Error("Snapshot unavailable")
        }
      if (boundary === "effect-save")
        value.ports.save = async (mission) => {
          if (mission.tasks[0]?.effectState === "running") throw new Error("Storage unavailable")
        }
      const run = createMissionRun(
        value.mission,
        value.ports,
        () => {},
        () => {},
      )
      await expect(run(value.actor, "Publish authorized artifact", "work", task.id)).rejects.toThrow()
      expect(value.runAgent).not.toHaveBeenCalled()
      expect(value.mission.tasks[0]?.effectState).toBe("not-started")
      expect(value.mission.execution?.runsStarted).toBe(1)
    },
  )

  it("records no dispatch durably when cancellation arrives during the external checkpoint save", async () => {
    const value = externalFixture()
    let cancelled = false
    value.ports.save = async (mission) => {
      value.snapshots.push(structuredClone(mission))
      if (mission.tasks[0]?.effectState === "running") cancelled = true
    }
    const run = createMissionRun(
      value.mission,
      value.ports,
      () => {},
      () => {
        if (cancelled) throw new MissionPause("Cancelled before dispatch", "interrupted")
      },
    )
    await expect(run(value.actor, "Publish authorized artifact", "work", task.id)).rejects.toThrow(
      "Cancelled before dispatch",
    )
    expect(value.runAgent).not.toHaveBeenCalled()
    expect(value.snapshots.at(-1)?.tasks[0]?.effectState).toBe("not-started")
  })

  it("keeps a returned external action completed when cancellation arrives after dispatch", async () => {
    const value = externalFixture()
    let cancelled = false
    value.runAgent.mockImplementation(async () => {
      cancelled = true
      return "Destination accepted the authorized artifact"
    })
    const run = createMissionRun(
      value.mission,
      value.ports,
      () => {},
      () => {
        if (cancelled) throw new MissionPause("Cancelled after dispatch", "interrupted")
      },
    )
    await expect(run(value.actor, "Publish authorized artifact", "work", task.id)).rejects.toThrow(
      "Cancelled after dispatch",
    )
    expect(value.runAgent).toHaveBeenCalledOnce()
    expect(value.mission.tasks[0]).toMatchObject({
      effectState: "completed",
      output: "Destination accepted the authorized artifact",
    })
    expect(value.snapshots.at(-1)?.tasks[0]?.effectState).toBe("completed")
  })

  it("preserves completed local evidence on a failed completion checkpoint and refuses replay", async () => {
    const value = externalFixture()
    value.ports.save = async (mission) => {
      if (mission.tasks[0]?.effectState === "completed") throw new Error("Storage unavailable")
    }
    const run = createMissionRun(
      value.mission,
      value.ports,
      () => {},
      () => {},
    )
    await expect(run(value.actor, "Publish authorized artifact", "work", task.id)).rejects.toBeInstanceOf(
      CheckpointError,
    )
    expect(value.mission.tasks[0]?.effectState).toBe("completed")
    await expect(run(value.actor, "Publish authorized artifact", "work", task.id)).rejects.toThrow("already completed")
    expect(value.runAgent).toHaveBeenCalledOnce()
  })

  it("does mark effects unknown when the invoked Actor fails without returning an outcome", async () => {
    const value = externalFixture()
    value.runAgent.mockRejectedValueOnce(new Error("Connection closed after remote acceptance"))
    const run = createMissionRun(
      value.mission,
      value.ports,
      () => {},
      () => {},
    )
    await expect(run(value.actor, "Publish authorized artifact", "work", task.id)).rejects.toThrow("Connection closed")
    expect(value.mission.tasks[0]?.effectState).toBe("unknown")
    await expect(run(value.actor, "Publish authorized artifact", "work", task.id)).rejects.toMatchObject({
      kind: "unknown-effect",
    })
    expect(value.runAgent).toHaveBeenCalledOnce()
  })

  it("persists readonly failure as integrity so automatic recovery cannot resume its pending Chief checkpoint", async () => {
    const value = fixture()
    const base = value.runAgent.getMockImplementation()
    value.runAgent.mockImplementation(async (...args) => {
      if (args[3] === "work") throw new Error("Worker failed")
      if (args[3] === "supervise") {
        value.mutate("unauthorized-change")
        return JSON.stringify({ action: "wait", reason: "Wait", retryAfterSec: 30 })
      }
      return (await base?.(...args)) ?? ""
    })
    await expect(coordinate(value.mission, value.ports)).rejects.toThrow("read-only stage")
    expect(value.mission.execution?.failureKind).toBe("integrity")
    expect(value.snapshots.at(-1)?.execution?.failureKind).toBe("integrity")
    expect(value.mission.supervision?.pendingRecovery).toBeDefined()
  })
})
