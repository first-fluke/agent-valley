import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain"
import { describe, expect, it, vi } from "vitest"
import { coordinate } from "./coordinator"
import { createMissionCheckpoint } from "./coordinator-checkpoint"
import { createCoordinatorGraph, runCoordinatorGraph } from "./coordinator-graph"
import { createMissionReporter } from "./coordinator-report"
import { CheckpointError, createMissionRun } from "./coordinator-run"
import type { CoordinatorContext } from "./coordinator-stages"
import { ContractViolation, createMissionContract } from "./coordinator-state"
import { executionPolicySchema, MissionPause } from "./execution"
import { fixture, rejected } from "./goal-supervision.fixture"
import type { ChiefPorts, Mission } from "./types"

const tracingFlags = ["LANGSMITH_TRACING", "LANGSMITH_TRACING_V2", "LANGCHAIN_TRACING", "LANGCHAIN_TRACING_V2"]

function contextFor(mission: Mission, ports: ChiefPorts): CoordinatorContext {
  const contract = createMissionContract(mission)
  const checkpoint = createMissionCheckpoint(mission, ports, contract.assert)
  const persona = (id: string) => {
    const actor = mission.personas.find((entry) => entry.id === id)
    if (!actor) throw new Error(`Unexpected Actor ${id} in graph fixture`)
    return actor
  }
  const checkAbort = () => {}
  const run = createMissionRun(mission, ports, contract.assert, checkAbort, checkpoint.persist)
  const unexpectedRecovery = async () => {
    throw new Error("Unexpected recovery in graph fixture")
  }
  return {
    mission,
    ports,
    operatorGoal: mission.goal,
    operatorVerify: mission.verifyCommand,
    contract,
    checkpoint,
    run,
    generateReport: createMissionReporter(mission, ports, run, persona, () => true),
    requestRecovery: unexpectedRecovery,
    requestRepair: unexpectedRecovery,
    persona,
    save: checkpoint.record,
    assertContract: contract.assert,
    checkAbort,
    protectedFailure: () => true,
    invalidate: () => {
      throw new Error("Unexpected approval invalidation in graph fixture")
    },
  }
}

describe("LangGraph Chief stage orchestration", () => {
  it("executes the compiled graph's six stage nodes against the shared mission and AV checkpoints", async () => {
    const { mission, ports, snapshots, runAgent, verify } = fixture()
    const graph = createCoordinatorGraph(contextFor(mission, ports))
    const visits: string[] = []
    const updates = await graph.stream({ nextStage: "resume" }, { streamMode: "updates" })
    for await (const update of updates) visits.push(...Object.keys(update))

    expect(visits).toEqual(["resume", "planning", "tasks", "verification", "approval", "report"])
    expect(mission.status).toBe("completed")
    expect(snapshots.at(-1)).toMatchObject({
      status: "completed",
      verification: { ok: true, fingerprint: "change-1" },
      finalReview: { passed: true },
    })
    expect(runAgent.mock.calls.map((call) => call[3])).toEqual(["plan", "work", "review", "final-review", "report"])
    expect(verify).toHaveBeenCalledOnce()
  })

  it("finishes a permitted repair loop longer than LangGraph's default recursion budget without resetting spent calls", async () => {
    const { mission, ports, runAgent, verify, snapshots } = fixture()
    mission.maxRepairs = 10
    mission.executionPolicy = executionPolicySchema.parse({ maxRuns: 40, maxParallel: 1 })
    mission.execution = { startedAt: new Date().toISOString(), runsStarted: 7, retries: 0 }
    const originalRun = runAgent.getMockImplementation()
    const reservedCalls: number[] = []
    runAgent.mockImplementation(async (...args) => {
      reservedCalls.push(args[2].execution?.runsStarted ?? -1)
      expect(snapshots.at(-1)?.execution?.runsStarted).toBe(args[2].execution?.runsStarted)
      return (await originalRun?.(...args)) ?? ""
    })
    let verifications = 0
    verify.mockImplementation(async () => {
      verifications += 1
      return verifications <= 10
        ? { ok: false, output: `Acceptance failure ${verifications}; repair the remaining missing state.` }
        : { ok: true, output: "All repaired acceptance checks passed." }
    })

    await coordinate(mission, ports)

    expect(mission.status).toBe("completed")
    expect(verify).toHaveBeenCalledTimes(11)
    expect(mission.tasks[0]?.attempts).toBe(11)
    expect(mission.repairRound).toBe(10)
    expect(mission.supervision?.rounds).toBe(0)
    expect(reservedCalls).toEqual(Array.from({ length: 25 }, (_, index) => index + 8))
    expect(mission.execution?.runsStarted).toBe(32)
    expect(snapshots.at(-1)?.execution?.runsStarted).toBe(32)
    const repairPrompts = runAgent.mock.calls.filter((call) => call[3] === "work").slice(1)
    repairPrompts.forEach((call, index) => {
      expect(call[1]).toContain(`Acceptance failure ${index + 1}`)
    })
  })

  it("returns a saved future Chief wait before planning, dispatch, verification or another checkpoint", async () => {
    const { mission, ports, runAgent, verify, snapshots } = fixture()
    mission.executionPolicy = executionPolicySchema.parse({})
    const originalRun = runAgent.getMockImplementation()
    runAgent.mockImplementation(async (...args) => {
      if (args[3] === "review") return rejected
      if (args[3] === "supervise")
        return JSON.stringify({
          action: "wait",
          reason: "Wait for the recorded measurement window.",
          retryAfterSec: 3_600,
        })
      return (await originalRun?.(...args)) ?? ""
    })
    await coordinate(mission, ports)
    expect(mission.status).toBe("waiting")
    expect(mission.execution?.failureKind).toBe("chief-wait")
    const before = structuredClone(mission)
    runAgent.mockClear()
    verify.mockClear()
    snapshots.length = 0
    const fingerprint = vi.fn(ports.fingerprint)
    ports.fingerprint = fingerprint

    expect(await coordinate(mission, ports)).toBe(mission)

    expect(mission).toEqual(before)
    expect(runAgent).not.toHaveBeenCalled()
    expect(verify).not.toHaveBeenCalled()
    expect(fingerprint).not.toHaveBeenCalled()
    expect(snapshots).toEqual([])
  })

  it.each(tracingFlags)("rejects ambient %s before graph execution or external tracing", async (flag) => {
    const { mission, ports, runAgent, verify, snapshots } = fixture()
    const handleChainStart = vi.spyOn(LangChainTracer.prototype, "handleChainStart")
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }))
    for (const key of tracingFlags) vi.stubEnv(key, "false")
    vi.stubEnv(flag, "TrUe")
    vi.stubEnv("LANGSMITH_API_KEY", "fixture-tracing-key")
    vi.stubEnv("LANGSMITH_ENDPOINT", "https://langsmith.invalid")
    vi.stubEnv("LANGCHAIN_CALLBACKS_BACKGROUND", "false")
    vi.stubGlobal("fetch", fetch)
    ports.fingerprint = vi.fn(ports.fingerprint)
    try {
      await expect(runCoordinatorGraph(contextFor(mission, ports))).rejects.toMatchObject({
        kind: "environment",
        message: expect.stringContaining(flag),
      })

      expect({ traceStarts: handleChainStart.mock.calls.length, requests: fetch.mock.calls.length }).toEqual({
        traceStarts: 0,
        requests: 0,
      })
      expect(ports.fingerprint).not.toHaveBeenCalled()
      expect(runAgent).not.toHaveBeenCalled()
      expect(verify).not.toHaveBeenCalled()
      expect(snapshots).toEqual([])
    } finally {
      handleChainStart.mockRestore()
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
    }
  })

  it("saves a paused environment outcome without Actor dispatch when tracing must be disabled", async () => {
    const { mission, ports, runAgent, verify, snapshots } = fixture()
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }))
    vi.stubGlobal("fetch", fetch)
    for (const key of tracingFlags) vi.stubEnv(key, "false")
    vi.stubEnv("LANGSMITH_TRACING", "true")
    ports.fingerprint = vi.fn(ports.fingerprint)
    try {
      await coordinate(mission, ports)

      expect(mission.status).toBe("paused")
      expect(mission.execution?.failureKind).toBe("environment")
      expect(mission.error).toContain("LANGSMITH_TRACING")
      expect(mission.report).toBeDefined()
      expect(snapshots.at(-1)).toMatchObject({
        status: "paused",
        execution: { failureKind: "environment" },
        report: mission.report,
      })
      expect(ports.fingerprint).not.toHaveBeenCalled()
      expect(runAgent).not.toHaveBeenCalled()
      expect(verify).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
    }
  })

  it("permits normal graph execution with tracing flags explicitly false", async () => {
    const { mission, ports } = fixture()
    for (const key of tracingFlags) vi.stubEnv(key, "false")
    try {
      await runCoordinatorGraph(contextFor(mission, ports))

      expect(mission.status).toBe("completed")
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("keeps concurrent mission contexts, checkpoints and spent-call budgets separate", async () => {
    const first = fixture()
    const second = fixture()
    first.mission.id = "concurrent-first"
    second.mission.id = "concurrent-second"
    first.mission.workspace.path = "/workspace/concurrent-first"
    second.mission.workspace.path = "/workspace/concurrent-second"
    first.mission.executionPolicy = executionPolicySchema.parse({ maxRuns: 30, maxParallel: 1 })
    second.mission.executionPolicy = executionPolicySchema.parse({ maxRuns: 30, maxParallel: 1 })
    first.mission.execution = { startedAt: new Date().toISOString(), runsStarted: 3, retries: 0 }
    second.mission.execution = { startedAt: new Date().toISOString(), runsStarted: 9, retries: 0 }
    let releaseWork = () => {}
    let enteredWork = () => {}
    const blocked = new Promise<void>((resolve) => {
      releaseWork = resolve
    })
    const entered = new Promise<void>((resolve) => {
      enteredWork = resolve
    })
    const originalRun = first.runAgent.getMockImplementation()
    first.runAgent.mockImplementation(async (...args) => {
      if (args[3] === "work") {
        enteredWork()
        await blocked
      }
      return (await originalRun?.(...args)) ?? ""
    })
    const running = coordinate(first.mission, first.ports)
    try {
      await entered
      await coordinate(second.mission, second.ports)

      expect(second.mission.status).toBe("completed")
      expect(second.mission.execution?.runsStarted).toBe(14)
      expect(first.mission.status).toBe("executing")
      expect(first.mission.execution?.runsStarted).toBe(5)
      expect(first.mission.fingerprint).toBe("initial")
      expect(first.snapshots.at(-1)?.tasks[0]?.status).toBe("running")
      expect(first.verify).not.toHaveBeenCalled()
      expect(first.snapshots.every((saved) => saved.id === "concurrent-first")).toBe(true)
      expect(second.snapshots.every((saved) => saved.id === "concurrent-second")).toBe(true)
    } finally {
      releaseWork()
      await running
    }
    expect(first.mission.status).toBe("completed")
    expect(first.mission.execution?.runsStarted).toBe(8)
    expect(first.runAgent.mock.calls.every((call) => call[2] === first.mission)).toBe(true)
    expect(second.runAgent.mock.calls.every((call) => call[2] === second.mission)).toBe(true)
    expect(first.snapshots.at(-1)?.execution?.runsStarted).toBe(8)
    expect(second.snapshots.at(-1)?.execution?.runsStarted).toBe(14)
  })

  it.each([
    { label: "MissionPause", error: new MissionPause("Saved budget is exhausted.", "budget") },
    { label: "frozen MissionPause", error: Object.freeze(new MissionPause("Frozen saved pause.", "budget")) },
    { label: "CheckpointError", error: new CheckpointError("Mission storage is unavailable.") },
    { label: "ContractViolation", error: new ContractViolation("Immutable verification command changed.") },
    { label: "primitive rejection", error: "Original primitive rejection" },
  ])("preserves $label identity through the graph runner", async ({ error }) => {
    const { mission, ports, runAgent, verify, snapshots } = fixture()
    ports.fingerprint = vi.fn(async () => {
      throw error
    })

    await expect(runCoordinatorGraph(contextFor(mission, ports))).rejects.toBe(error)

    expect(ports.fingerprint).toHaveBeenCalledOnce()
    expect(runAgent).not.toHaveBeenCalled()
    expect(verify).not.toHaveBeenCalled()
    expect(snapshots).toEqual([])
  })
})
