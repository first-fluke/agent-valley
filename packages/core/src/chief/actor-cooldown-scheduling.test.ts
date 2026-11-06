import { describe, expect, it, vi } from "vitest"
import { runContinuousOperation } from "./continuous-operation"
import {
  baseline,
  mission as childMission,
  operation,
  fixture as operationFixture,
  timestamp,
} from "./continuous-operation.fixture"
import { automaticMissionRecovery } from "./continuous-recovery"
import { coordinate } from "./coordinator"
import { executionPolicySchema } from "./execution"
import { brief, fixture, plan } from "./goal-supervision.fixture"
import type { OperatingRun } from "./operations"
import { validateMission } from "./schemas"
import type { Mission } from "./types"

function waitingMission() {
  const value = fixture()
  value.mission.plan = structuredClone(plan)
  value.mission.goalBrief = structuredClone(brief)
  value.mission.tasks = [{ id: "onboarding", status: "pending", attempts: 3, reviewerId: "reviewer" }]
  const task = plan.tasks[0]
  if (!value.mission.supervision || !task) throw new Error("Expected supervised task")
  value.mission.supervision.originalAcceptance = [...task.acceptance]
  value.mission.executionPolicy = executionPolicySchema.parse({ maxRuns: 20, maxParallel: 1 })
  value.mission.status = "waiting"
  value.mission.execution = {
    startedAt: new Date(Date.now() - 1_000).toISOString(),
    runsStarted: 4,
    retries: 2,
    crashRestarts: 1,
    failureKind: "actor-cooldown",
    pauseReason: "The selected Actor is cooling down after native failures.",
    nextRunAt: new Date(Date.now() + 60_000).toISOString(),
  }
  Object.assign(value.mission, validateMission(value.mission))
  return value
}

function waitingChild(delaySec = 1) {
  const decision = {
    action: "execute" as const,
    goal: "Finish saved work",
    reason: "Original evidence",
    evidence: ["saved"],
  }
  const value = operationFixture(
    operation({ baseline: baseline(), phase: "running", currentMissionId: "child", decision, cycleLimit: 1 }),
  )
  const child = childMission("child", decision.goal, "waiting")
  child.executionPolicy = executionPolicySchema.parse({ maxRuns: 20 })
  child.execution = {
    startedAt: timestamp,
    runsStarted: 4,
    retries: 2,
    crashRestarts: 1,
    failureKind: "actor-cooldown",
    nextRunAt: new Date(Date.parse(timestamp) + delaySec * 1_000).toISOString(),
  }
  child.supervision = {
    maxRounds: 2,
    rounds: 2,
    stalledRounds: 0,
    decisions: [],
    originalAcceptance: ["Verified improvement"],
  }
  value.children.set(child.id, child)
  return { ...value, child }
}

function nativeRun(mission: Mission, overrides: Partial<OperatingRun>) {
  mission.operations ??= { runs: [], routingEvidence: [], reviewDecisions: [] }
  mission.operations.runs.push({
    runId: "native",
    actorId: "worker",
    actorType: "codex",
    stage: "work",
    startedAt: timestamp,
    finishedAt: timestamp,
    elapsedMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    outcome: "failed",
    executionState: "settled",
    ...overrides,
  })
}

describe("saved Actor cooldown scheduling", () => {
  it("makes repeated early coordinator resumes read-only without spending calls, retries or Chief rounds", async () => {
    const { mission, ports, runAgent, verify, snapshots } = waitingMission()
    const before = structuredClone(mission)
    const fingerprint = vi.fn(ports.fingerprint)
    ports.fingerprint = fingerprint

    for (let attempt = 0; attempt < 3; attempt += 1) {
      Object.assign(mission, validateMission(structuredClone(mission)))
      expect(await coordinate(mission, ports)).toBe(mission)
      expect(mission).toEqual(before)
    }

    expect(runAgent).not.toHaveBeenCalled()
    expect(verify).not.toHaveBeenCalled()
    expect(fingerprint).not.toHaveBeenCalled()
    expect(snapshots).toEqual([])
  })

  it("clears an expired cooldown and continues the saved task with original spending retained", async () => {
    const { mission, ports, runAgent } = waitingMission()
    if (!mission.execution) throw new Error("Expected execution checkpoint")
    mission.execution.nextRunAt = new Date(Date.now() - 1).toISOString()
    const startedAt = mission.execution.startedAt
    const originalPlan = structuredClone(mission.plan)

    await coordinate(mission, ports)

    expect(mission.status).toBe("completed")
    expect(runAgent.mock.calls.map((call) => call[3])).toEqual(["work", "review", "final-review"])
    expect(mission.plan).toEqual(originalPlan)
    expect(mission.execution).toMatchObject({ startedAt, runsStarted: 7, retries: 2, crashRestarts: 1 })
    expect(mission.execution?.failureKind).toBeUndefined()
    expect(mission.execution?.nextRunAt).toBeUndefined()
    expect(mission.supervision?.rounds).toBe(0)
  })

  it("rejects a missing cooldown schedule before dispatch", async () => {
    const { mission, ports, runAgent } = waitingMission()
    if (!mission.execution) throw new Error("Expected execution checkpoint")
    delete mission.execution.nextRunAt

    await coordinate(mission, ports)

    expect(runAgent).not.toHaveBeenCalled()
    expect(mission.execution?.failureKind).toBe("integrity")
    expect(mission.execution?.runsStarted).toBe(4)
  })

  it("allows a saved cooldown to continue work without opening another Chief recovery round", () => {
    const { child } = waitingChild()
    const before = structuredClone(child)
    expect(automaticMissionRecovery(child, Date.parse(timestamp))).toMatchObject({
      retry: true,
      waitUntil: child.execution?.nextRunAt,
    })
    expect(child).toEqual(before)
  })

  it.each([
    "calls",
    "duration",
    "Chief stop",
    "interrupted",
    "unknown effect",
    "unknown execution",
    "unknown billing",
    "spent cost",
    "disabled",
    "invalid timestamp",
  ])("keeps the %s barrier during cooldown", (barrier) => {
    const { child } = waitingChild()
    if (!child.execution || !child.executionPolicy || !child.supervision) throw new Error("Expected saved limits")
    if (barrier === "calls") child.executionPolicy.maxRuns = child.execution.runsStarted
    if (barrier === "duration") child.executionPolicy.maxDurationSec = 1
    if (barrier === "Chief stop")
      child.supervision.decisions.push({
        round: 2,
        at: timestamp,
        action: "stop",
        reason: "Unresolved",
        fingerprint: "saved",
      })
    if (barrier === "interrupted") child.execution.failureKind = "interrupted"
    if (barrier === "unknown effect") {
      const task = child.tasks[0]
      if (!task) throw new Error("Expected saved task")
      task.effectState = "unknown"
    }
    if (barrier === "unknown execution") nativeRun(child, { executionState: "unknown", finishedAt: null })
    if (barrier === "unknown billing" || barrier === "spent cost") {
      child.executionPolicy.maxEstimatedCostUsd = 1
      nativeRun(child, { costUsd: barrier === "spent cost" ? 1 : null })
    }
    if (barrier === "disabled") child.executionPolicy.autoResume = false
    if (barrier === "invalid timestamp") child.execution.nextRunAt = "invalid"
    const before = structuredClone(child)
    expect(automaticMissionRecovery(child, Date.parse(timestamp) + 1_000).retry).toBe(false)
    expect(child).toEqual(before)
  })

  it("stops at the original deadline during a longer cooldown without a child call", async () => {
    const { record, ports, child } = waitingChild(60)
    if (!child.executionPolicy) throw new Error("Expected execution policy")
    child.executionPolicy.maxDurationSec = 2
    ports.runMission = vi.fn(async () => child)

    await runContinuousOperation(record, ports)

    expect(ports.runMission).not.toHaveBeenCalled()
    expect(record.phase).toBe("paused")
    expect(record.error).toContain("time limit reached")
    expect(record.recovery).toMatchObject({ attempts: 0, failedAttempts: 0, disposition: "protected" })
    expect(child.execution).toMatchObject({ runsStarted: 4, retries: 2, crashRestarts: 1, startedAt: timestamp })
  })

  it("honors successive cooldowns without consuming failed child recovery allowance", async () => {
    const { record, ports, child } = waitingChild()
    const original = structuredClone(child)
    let resumed = 0
    ports.runMission = vi.fn(async () => {
      if (!ports.now || !child.execution?.nextRunAt) throw new Error("Expected saved cooldown clock")
      const at = ports.now()
      expect(at.getTime()).toBeGreaterThanOrEqual(Date.parse(child.execution.nextRunAt))
      expect(record.recovery?.failedAttempts).toBe(0)
      resumed += 1
      if (resumed === 5) child.status = "completed"
      else child.execution.nextRunAt = new Date(at.getTime() + 2 ** resumed * 1_000).toISOString()
      return child
    })

    await runContinuousOperation(record, ports)

    expect(record).toMatchObject({ phase: "completed", completedCycles: 1 })
    expect(ports.runMission).toHaveBeenCalledTimes(5)
    expect(ports.decide).not.toHaveBeenCalled()
    expect(child.execution?.runsStarted).toBe(original.execution?.runsStarted)
    expect(child.execution?.retries).toBe(original.execution?.retries)
    expect(child.supervision).toEqual(original.supervision)
  })

  it("retains a pending wait exemption across interrupted early resumes without replenishing spent failures", async () => {
    const { record, ports, child } = waitingChild()
    record.recovery = {
      target: "child",
      checkpointId: child.id,
      attempts: 3,
      failedAttempts: 3,
      disposition: "protected",
      reason: "Previous failure allowance was spent",
    }
    const delay = ports.delay
    ports.runMission = vi.fn(async () => {
      child.status = "completed"
      return child
    })
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const controller = new AbortController()
      ports.signal = controller.signal
      ports.delay = vi.fn(async () => {
        controller.abort()
        throw new Error("Interrupted owned test wait")
      })
      await runContinuousOperation(record, ports)
      expect(ports.delay).toHaveBeenCalledOnce()
      expect(ports.runMission).not.toHaveBeenCalled()
      expect(record.recovery).toMatchObject({ attempts: 3, failedAttempts: 3 })
    }
    ports.signal = undefined
    ports.delay = delay

    await runContinuousOperation(record, ports)

    expect(ports.runMission).toHaveBeenCalledOnce()
    expect(record.phase).toBe("completed")
  })

  it("bounds an expired cooldown checkpoint that never advances after dispatch", async () => {
    const { record, ports, child } = waitingChild()
    if (!child.supervision) throw new Error("Expected supervision")
    child.supervision.rounds = 1
    ports.runMission = vi.fn(async () => child)

    await runContinuousOperation(record, ports)

    expect(ports.runMission).toHaveBeenCalledTimes(4)
    expect(record.recovery).toMatchObject({ attempts: 4, failedAttempts: 3, disposition: "unresolved" })
    expect(record.phase).toBe("paused")
  })
})
