import { assertExecutionBudget, executionPolicySchema } from "@agent-valley/core/chief/execution"
import type { OperatingRun } from "@agent-valley/core/chief/operations"
import { mission as missionFixture } from "@agent-valley/core/chief/reports.fixture"
import { goalVerificationContractDigest, goalVerificationContractSchema } from "@agent-valley/core/chief/verification"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { OrderOptions } from "../chief-config"
import { applyResumeOptions } from "../chief-resume"

const now = Date.parse("2026-10-03T10:00:00Z")
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
})
afterEach(() => {
  vi.useRealTimers()
})
function mission() {
  const value = missionFixture()
  value.status = "paused"
  value.executionPolicy = executionPolicySchema.parse({ maxRuns: 10, maxDurationSec: 100, maxEstimatedCostUsd: 1 })
  value.execution = {
    startedAt: new Date(now - 50_000).toISOString(),
    runsStarted: 10,
    retries: 3,
    crashRestarts: 3,
    failureKind: "budget",
    pauseReason: "Call limit",
    nextRunAt: new Date(now + 1_000).toISOString(),
  }
  return value
}
function unknownCostRun(): OperatingRun {
  return {
    runId: "interrupted-call",
    stage: "work",
    actorId: "worker",
    actorType: "codex",
    startedAt: new Date(now - 5_000).toISOString(),
    finishedAt: new Date(now - 1_000).toISOString(),
    elapsedMs: 4_000,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    outcome: "failed",
  }
}

describe("operator resume without weakening acceptance or resetting spend", () => {
  it("increases limits while retaining original goal, roster, checks, spent calls and elapsed time", () => {
    const current = mission()
    const original = structuredClone(current)
    applyResumeOptions(current, undefined, { resume: current.id, runs: "20", duration: "200", cost: "2", rounds: "4" })
    expect(current.executionPolicy).toMatchObject({ maxRuns: 20, maxDurationSec: 200, maxEstimatedCostUsd: 2 })
    expect(current.execution).toMatchObject({
      startedAt: original.execution?.startedAt,
      runsStarted: 10,
      retries: 0,
      crashRestarts: 0,
      interventionAt: new Date(now).toISOString(),
    })
    expect(current.goal).toBe(original.goal)
    expect(current.verifyCommand).toBe(original.verifyCommand)
    expect(current.goalBrief).toEqual(original.goalBrief)
    expect(current.personas).toEqual(original.personas)
    expect(current.supervision?.originalAcceptance).toEqual(original.supervision?.originalAcceptance)
    expect(current.supervision?.decisions).toEqual(original.supervision?.decisions)
    expect(current.status).toBe("pending")
    expect(current.execution?.pauseReason).toBeUndefined()
    expect(current.execution?.nextRunAt).toBeUndefined()
  })

  it.each([
    { runs: "9" },
    { duration: "99" },
    { cost: "0.5" },
    { cost: "NaN" },
    { cost: "Infinity" },
    { rounds: "2" },
    { runs: "1.5" },
  ])("rejects reduced or invalid execution limits %j", (options) => {
    const current = mission()
    expect(() => applyResumeOptions(current, undefined, { resume: current.id, ...options })).toThrow()
    expect(current.execution?.runsStarted).toBe(10)
    expect(current.execution?.startedAt).toBe(new Date(now - 50_000).toISOString())
    expect(current.status).toBe("paused")
  })

  it.each([
    { verify: "true" },
    { actor: "claude" },
    { model: "cheaper" },
    { workspace: "/other-repo" },
    { parallel: "8" },
  ])("retains the immutable mission contract when resume includes %j", (options) => {
    const current = mission()
    const before = structuredClone(current)
    expect(() => applyResumeOptions(current, undefined, { resume: current.id, ...options })).toThrow("saved goal")
    expect(current).toEqual(before)
  })

  it("rejects a new goal and leaves a plain resume checkpoint unchanged", () => {
    const current = mission()
    const before = structuredClone(current)
    expect(() => applyResumeOptions(current, "Skip acceptance checks", { resume: current.id })).toThrow()
    applyResumeOptions(current, undefined, { resume: current.id })
    expect(current).toEqual(before)
  })

  it("explicit retry renews provider retry allowance while retaining spent calls and original checks", () => {
    const current = mission()
    applyResumeOptions(current, undefined, { resume: current.id, retry: true })
    expect(current.execution).toMatchObject({
      retries: 0,
      crashRestarts: 0,
      runsStarted: 10,
      startedAt: new Date(now - 50_000).toISOString(),
    })
    expect(current.supervision?.rounds).toBe(1)
    expect(current.verifyCommand).toBe("bun test")
    expect(() => assertExecutionBudget(current)).toThrow("call limit")
  })

  it("retains Chief-designed executable checks and their digest when execution limits change", () => {
    const current = mission()
    current.verificationContract = goalVerificationContractSchema.parse({
      version: 1,
      criteria: (current.goalBrief?.successCriteria ?? []).map((criterion) => ({
        criterion,
        checks: [{ kind: "file", path: "src/login.tsx", contains: ["login"] }],
      })),
    })
    current.verificationContractSha256 = goalVerificationContractDigest(current.verificationContract)
    const contract = structuredClone(current.verificationContract)
    const digest = current.verificationContractSha256
    applyResumeOptions(current, undefined, { resume: current.id, runs: "20", retry: true })
    expect(current.verificationContract).toEqual(contract)
    expect(current.verificationContractSha256).toBe(digest)
  })

  it("requires a complete explicit external-effect reconciliation pair", () => {
    for (const options of [
      { resolveEffect: "login" },
      { effectResult: "completed" },
      { resolveEffect: "login", effectResult: "invented" },
    ]) {
      const current = mission()
      expect(() => applyResumeOptions(current, undefined, { resume: current.id, ...options } as OrderOptions)).toThrow(
        "completed|not-applied",
      )
    }
    const current = mission()
    const task = current.plan?.tasks[0]
    const state = current.tasks[0]
    if (!task || !state) throw new Error("Expected fixture task")
    task.effectScope = "external"
    state.effectState = "unknown"
    applyResumeOptions(current, undefined, { resume: current.id, resolveEffect: "login", effectResult: "completed" })
    expect(state.effectState).toBe("completed")
    expect(current.history.some((event) => event.stage === "effect-resolved")).toBe(true)
    expect(current.status).toBe("pending")
  })

  it("requires both cost accounting flags and a valid measured amount", () => {
    for (const options of [{ accountRun: "interrupted-call" }, { accountCost: "0.25" }]) {
      const current = mission()
      expect(() => applyResumeOptions(current, undefined, { resume: current.id, ...options })).toThrow("--account-run")
      expect(current.execution?.costReconciliations).toBeUndefined()
    }
    for (const accountCost of ["-1", "NaN", "Infinity", "", " "]) {
      const current = mission()
      current.operations = { runs: [unknownCostRun()], routingEvidence: [], reviewDecisions: [] }
      expect(() =>
        applyResumeOptions(current, undefined, { resume: current.id, accountRun: "interrupted-call", accountCost }),
      ).toThrow()
      expect(current.execution?.costReconciliations).toBeUndefined()
    }
  })

  it.each(["0", "0.25"])(
    "records explicit accounting value %s without rewriting unknown native cost or resetting spent budget",
    (accountCost) => {
      const current = mission()
      current.operations = { runs: [unknownCostRun()], routingEvidence: [], reviewDecisions: [] }
      const before = structuredClone(current)
      applyResumeOptions(current, undefined, { resume: current.id, accountRun: "interrupted-call", accountCost })
      expect(current.execution?.costReconciliations).toEqual([
        {
          runId: "interrupted-call",
          costUsd: Number(accountCost),
          at: new Date(now).toISOString(),
          authority: "operator-recorded",
        },
      ])
      expect(current.operations.runs[0]?.costUsd).toBeNull()
      expect(current.execution?.runsStarted).toBe(before.execution?.runsStarted)
      expect(current.execution?.startedAt).toBe(before.execution?.startedAt)
      expect(current.executionPolicy).toEqual(before.executionPolicy)
      expect(current.goal).toBe(before.goal)
      expect(current.verifyCommand).toBe(before.verifyCommand)
      expect(current.goalBrief).toEqual(before.goalBrief)
      expect(current.status).toBe("pending")
      expect(() => assertExecutionBudget(current)).toThrow("call limit")
    },
  )

  it("combines accounting with a limit increase while enforcing the reconciled cost against the original goal", () => {
    const current = mission()
    current.operations = { runs: [unknownCostRun()], routingEvidence: [], reviewDecisions: [] }
    const goal = current.goal
    applyResumeOptions(current, undefined, {
      resume: current.id,
      accountRun: "interrupted-call",
      accountCost: "0.75",
      runs: "20",
    })
    expect(() => assertExecutionBudget(current)).not.toThrow()
    expect(current.executionPolicy?.maxEstimatedCostUsd).toBe(1)
    expect(current.goal).toBe(goal)
    applyResumeOptions(current, undefined, { resume: current.id, accountRun: "interrupted-call", accountCost: "1.25" })
    expect(() => assertExecutionBudget(current)).toThrow("cost limit")
  })
})

describe("Chief recovery without an operator decision", () => {
  function recoverable() {
    const current = mission()
    if (!current.execution || !current.executionPolicy || !current.supervision) throw new Error("Expected policy")
    current.executionPolicy.maxRuns = 30
    current.execution.failureKind = "environment"
    current.execution.pauseReason = "Worker dependency unavailable"
    delete current.execution.nextRunAt
    current.supervision.pendingRecovery = { reason: "Worker dependency unavailable", taskId: "login" }
    current.supervision.stalledRounds = 1
    return current
  }

  it.each(["paused", "failed"] as const)("continues a %s recovery with no retry flag or accounting reset", (status) => {
    const current = recoverable()
    current.status = status
    const before = structuredClone(current)
    applyResumeOptions(current, undefined, { resume: current.id })
    expect(current.status).toBe("pending")
    expect(current.execution).toEqual(before.execution)
    expect(current.executionPolicy).toEqual(before.executionPolicy)
    expect(current.supervision).toEqual(before.supervision)
    expect(current.goal).toBe(before.goal)
    expect(current.personas).toEqual(before.personas)
    expect(current.tasks).toEqual(before.tasks)
    expect(current.verifyCommand).toBe(before.verifyCommand)
    expect(current.history.at(-1)?.stage).toBe("chief-resume")
    expect(current.execution?.interventionAt).toBeUndefined()
  })

  it.each(["unknown-effect", "interrupted", "budget"] as const)("retains a protected %s checkpoint", (kind) => {
    const current = recoverable()
    if (!current.execution) throw new Error("Expected execution")
    current.execution.failureKind = kind
    const before = structuredClone(current)
    applyResumeOptions(current, undefined, { resume: current.id })
    expect(current).toEqual(before)
  })

  it("honors the Chief's stop decision and disabled automatic recovery", () => {
    for (const stopped of [true, false]) {
      const current = recoverable()
      if (!current.executionPolicy || !current.supervision) throw new Error("Expected policy")
      if (stopped)
        current.supervision.decisions.push({
          round: 2,
          at: new Date(now).toISOString(),
          action: "stop",
          reason: "No authorized recovery is available",
          fingerprint: "same",
        })
      else current.executionPolicy.autoResume = false
      const before = structuredClone(current)
      applyResumeOptions(current, undefined, { resume: current.id })
      expect(current).toEqual(before)
    }
  })

  it("leaves a scheduled Chief wait intact for the supervisor to honor", () => {
    const current = recoverable()
    if (!current.execution) throw new Error("Expected execution")
    current.status = "waiting"
    current.execution.failureKind = "chief-wait"
    current.execution.nextRunAt = new Date(now + 60_000).toISOString()
    const before = structuredClone(current)
    applyResumeOptions(current, undefined, { resume: current.id })
    expect(current).toEqual(before)
  })
})
