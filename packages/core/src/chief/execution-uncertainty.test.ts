import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { automaticMissionRecovery, verifiedMissionEvidence } from "./continuous-recovery"
import { coordinate } from "./coordinator"
import {
  assertExecutionBudget,
  executionPolicySchema,
  finalizeAbandonedRuns,
  pauseForFailure,
  reconcileExecution,
} from "./execution"
import { brief, fixture, plan } from "./goal-supervision.fixture"
import type { OperatingRun } from "./operations"
import { MissionStore } from "./store"
import { finishOperatingRun, markOperatingRunUnknown } from "./usage"

const unresolvedRun = (overrides: Partial<OperatingRun> = {}): OperatingRun => ({
  runId: "remote-attempt",
  taskId: "onboarding",
  stage: "work",
  actorId: "worker",
  actorType: "cursor",
  startedAt: new Date().toISOString(),
  finishedAt: null,
  elapsedMs: null,
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  outcome: "pending",
  executionState: "unknown",
  executionRecovery: "reconcile",
  evidence: "Submission was accepted but its response was lost.",
  ...overrides,
})

describe("uncertain runtime execution", () => {
  it("retains an uncertain workspace execution across restart and never resets or redispatches its task", async () => {
    const { mission, ports, runAgent } = fixture()
    mission.plan = plan
    mission.goalBrief = brief
    if (mission.supervision) mission.supervision.originalAcceptance = plan.tasks.flatMap((task) => task.acceptance)
    mission.tasks = [{ id: "onboarding", reviewerId: "reviewer", status: "running", attempts: 1 }]
    mission.operations = { runs: [unresolvedRun()], routingEvidence: [], reviewDecisions: [] }
    const directory = await mkdtemp(join(tmpdir(), "av-uncertain-run-"))
    try {
      const store = new MissionStore(directory)
      await store.save(mission)
      const restored = await store.load(mission.id)
      const previousRun = structuredClone(restored.operations?.runs[0])
      await coordinate(restored, { ...ports, save: (current) => store.save(current) })
      expect(restored.status).toBe("paused")
      expect(restored.execution?.failureKind).toBe("unknown-effect")
      expect(restored.tasks[0]).toMatchObject({ status: "running", attempts: 1 })
      expect(restored.operations?.runs[0]).toEqual(previousRun)
      expect(runAgent).not.toHaveBeenCalled()
      expect((await store.load(mission.id)).operations?.runs[0]).toEqual(previousRun)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("requires reconciliation for an unfinished nonlocal run and keeps legacy and proven local recovery", () => {
    const { mission } = fixture()
    mission.operations = {
      runs: [
        unresolvedRun({ executionState: "running" }),
        unresolvedRun({ runId: "local", executionState: "running", executionRecovery: "local-process" }),
        unresolvedRun({ runId: "legacy", executionState: undefined, executionRecovery: undefined }),
      ],
      routingEvidence: [],
      reviewDecisions: [],
    }
    finalizeAbandonedRuns(mission)
    expect(mission.operations.runs[0]).toMatchObject({
      executionState: "unknown",
      finishedAt: null,
      outcome: "pending",
    })
    for (const run of mission.operations.runs.slice(1))
      expect(run).toMatchObject({ executionState: "settled", finishedAt: expect.any(String), outcome: "failed" })
  })

  it("does not turn an uncertain transport error into a provider retry", () => {
    const { mission } = fixture()
    mission.executionPolicy = executionPolicySchema.parse({})
    mission.operations = { runs: [unresolvedRun()], routingEvidence: [], reviewDecisions: [] }
    expect(() => pauseForFailure(mission, "ETIMEDOUT after acceptance", "onboarding")).toThrow("execution")
    expect(mission.execution?.retries ?? 0).toBe(0)
  })

  it("preserves an uncertain cancellation when usage finalization runs afterward", () => {
    const { mission } = fixture()
    const entry = unresolvedRun({ executionState: "running", executionRecovery: "local-process" })
    markOperatingRunUnknown(entry, "Cancellation was requested but termination could not be established.")
    finishOperatingRun(
      mission,
      entry,
      {
        id: entry.runId,
        issueId: mission.id,
        workspacePath: mission.workspace.path,
        startedAt: entry.startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: null,
        agentOutput: null,
        tokenUsage: { input: 5, output: 2, model: "observed-model" },
      },
      true,
    )
    expect(entry).toMatchObject({
      executionState: "unknown",
      outcome: "pending",
      finishedAt: null,
      inputTokens: 5,
      outputTokens: 2,
      evidence: expect.stringContaining("termination could not be established"),
    })
  })

  it("blocks a same-process uncertain work failure before Chief recovery can submit another run", async () => {
    const value = fixture()
    const original = value.runAgent.getMockImplementation()
    value.runAgent.mockImplementation(async (...args) => {
      if (args[3] === "work") {
        args[2].operations = { runs: [unresolvedRun()], routingEvidence: [], reviewDecisions: [] }
        throw new Error("fetch failed after task acceptance")
      }
      return (await original?.(...args)) ?? ""
    })
    await coordinate(value.mission, value.ports)
    expect(value.mission).toMatchObject({ status: "paused", execution: { failureKind: "unknown-effect" } })
    expect(value.runAgent.mock.calls.filter((call) => call[3] === "work")).toHaveLength(1)
    expect(value.runAgent.mock.calls.filter((call) => call[3] === "supervise")).toHaveLength(0)
    expect(value.mission.supervision?.rounds).toBe(0)
    expect(value.mission.operations?.runs[0]).toMatchObject({
      executionState: "unknown",
      outcome: "pending",
      evidence: "Submission was accepted but its response was lost.",
    })
  })

  it("rejects completion evidence and automatic recovery while a runtime outcome is uncertain", async () => {
    const { mission, ports } = fixture()
    await coordinate(mission, ports)
    expect(verifiedMissionEvidence(mission)).toBe(true)
    mission.executionPolicy = executionPolicySchema.parse({ autoResume: true })
    mission.operations = { runs: [unresolvedRun()], routingEvidence: [], reviewDecisions: [] }
    expect(verifiedMissionEvidence(mission)).toBe(false)
    expect(automaticMissionRecovery(mission).retry).toBe(false)
  })

  it("records termination proof without approving work, resolving task effects or inventing billing", () => {
    const { mission } = fixture()
    mission.executionPolicy = executionPolicySchema.parse({ maxEstimatedCostUsd: 1 })
    mission.tasks = [
      { id: "onboarding", reviewerId: "reviewer", status: "running", attempts: 1, effectState: "running" },
    ]
    mission.operations = { runs: [unresolvedRun()], routingEvidence: [], reviewDecisions: [] }
    expect(() => reconcileExecution(mission, "remote-attempt", " ")).toThrow("evidence")
    expect(() => reconcileExecution(mission, "missing", "Stopped at the destination.")).toThrow()
    expect(() => reconcileExecution(mission, "remote-attempt", "Stopped.", "local-process-guard")).toThrow(
      "nonlocal execution",
    )
    reconcileExecution(mission, "remote-attempt", "Destination task is terminated; inspected task status and logs.")
    expect(mission.operations.runs[0]).toMatchObject({
      executionState: "settled",
      outcome: "failed",
      finishedAt: expect.any(String),
      costUsd: null,
    })
    expect(mission.tasks[0]).toMatchObject({ status: "running", attempts: 1, effectState: "unknown" })
    expect(mission.history.at(-1)).toMatchObject({
      stage: "execution-reconciled",
      taskId: "onboarding",
      message: expect.stringContaining('"authority":"operator-recorded"'),
    })
    expect(() => assertExecutionBudget(mission)).toThrow("Cost headroom is unknown")
    expect(() => reconcileExecution(mission, "remote-attempt", "Stopped.")).toThrow()
  })

  it.each(["local-process", "reconcile"] as const)(
    "uses a proven stopped local marker only to reconcile a %s execution",
    async (executionRecovery) => {
      const { mission } = fixture()
      mission.operations = {
        runs: [unresolvedRun({ executionRecovery })],
        routingEvidence: [],
        reviewDecisions: [],
      }
      const directory = await mkdtemp(join(tmpdir(), "av-local-proof-"))
      const kill = process.kill.bind(process)
      const deadPid = 987_654_321
      const inspection = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (Math.abs(pid) === deadPid && signal === 0)
          throw Object.assign(new Error("No such process"), { code: "ESRCH" })
        return kill(pid, signal)
      })
      try {
        const store = new MissionStore(directory)
        await store.save(mission)
        const guard = store.processGuard(mission.id, "remote-attempt")
        guard.begin("work")
        guard.spawned(deadPid, true)
        await store.recoverProcesses(mission.id, mission)
        const restored = await store.load(mission.id)
        if (executionRecovery === "local-process") {
          expect(restored.operations?.runs[0]).toMatchObject({ executionState: "settled", outcome: "failed" })
          expect(restored.history.at(-1)?.message).toContain('"authority":"local-process-guard"')
        } else {
          expect(restored.operations?.runs[0]).toMatchObject({ executionState: "unknown", finishedAt: null })
          expect(restored.history).toEqual([])
        }
      } finally {
        inspection.mockRestore()
        await rm(directory, { recursive: true, force: true })
      }
    },
  )

  it("retains local uncertainty when no matching process marker establishes termination", async () => {
    const { mission } = fixture()
    mission.operations = {
      runs: [unresolvedRun({ executionRecovery: "local-process" })],
      routingEvidence: [],
      reviewDecisions: [],
    }
    const directory = await mkdtemp(join(tmpdir(), "av-missing-proof-"))
    try {
      const store = new MissionStore(directory)
      await store.save(mission)
      await store.recoverProcesses(mission.id, mission)
      expect(mission.operations.runs[0]?.executionState).toBe("unknown")
      expect(mission.history).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
