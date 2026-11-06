import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RunAttempt } from "../domain/models"
import type { AgentRunnerPort, RunHandle, SpawnInput } from "../domain/ports/agent-runner"
import { coordinate } from "./coordinator"
import { applyTaskReviewResult } from "./coordinator-results"
import { createMissionRun } from "./coordinator-run"
import { executionPolicySchema } from "./execution"
import { fixture } from "./goal-supervision.fixture"
import type { OperatingRun } from "./operations"
import { workPrompt } from "./prompts"
import { routeEvidence } from "./routing"
import { ChiefRuntime } from "./runtime"
import { parseReview } from "./schemas"
import { MissionStore } from "./store"
import type { ChiefPorts, ChiefTask, Mission, Persona } from "./types"

const finding =
  'Enforce the JSON-object envelope: [1,"req-1","daemon.hello",null] must be rejected before dispatch; preserve the original protocol and storage migration.'
const fingerprint = "retained-ipc-worktree"
let directory: string
let mission: Mission
let store: MissionStore
let runtime: ChiefRuntime | undefined

function worker(current = mission): Persona {
  const actor = current.personas.find((entry) => entry.id === "worker")
  if (!actor) throw new Error("Missing worker fixture")
  return actor
}

function task(current = mission, id = "task-ipc"): ChiefTask {
  const entry = current.plan?.tasks.find((entry) => entry.id === id)
  if (!entry) throw new Error("Missing task fixture")
  return entry
}

function priorWork(): OperatingRun {
  return {
    runId: "independently-reviewed-ipc-work",
    actorId: "worker",
    actorType: "opencode",
    stage: "work",
    taskId: "task-ipc",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    finishedAt: new Date(Date.now() - 30_000).toISOString(),
    elapsedMs: 30_000,
    inputTokens: 100,
    outputTokens: 20,
    costUsd: 0.004,
    outcome: "pending",
    executionState: "settled",
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "chief-routing-recovery-"))
  mission = fixture().mission
  mission.goal = "Enforce the original IPC JSON-object protocol and preserve the frozen storage migration"
  mission.goalBrief = {
    interpretation: mission.goal,
    assumptions: [],
    successCriteria: ["Reject non-object IPC roots and preserve valid object requests"],
  }
  mission.workspace.path = directory
  mission.availableSkills = []
  mission.availableAgents = ["codex", "qwen", "opencode", "grok"]
  const chief = mission.personas.find((entry) => entry.id === mission.chiefId)
  if (!chief) throw new Error("Missing Chief fixture")
  chief.agentType = "grok"
  chief.model = "selected-chief"
  worker().agentType = "qwen"
  const reviewer = mission.personas.find((entry) => entry.id === "reviewer")
  if (!reviewer) throw new Error("Missing reviewer fixture")
  reviewer.agentType = "codex"
  mission.plan = {
    tasks: [
      {
        id: "task-ipc",
        title: "Repair IPC envelope",
        personaId: "worker",
        instructions: "Repair the retained independent review finding",
        acceptance: ["Reject non-object IPC roots and preserve valid object requests"],
        dependencies: [],
        effectScope: "workspace",
      },
    ],
  }
  mission.tasks = [
    {
      id: "task-ipc",
      status: "pending",
      attempts: 4,
      repairRound: 1,
      reviewerId: "reviewer",
      output: "Prior IPC work requires the saved repair",
    },
  ]
  mission.maxRepairs = 2
  if (!mission.supervision) throw new Error("Missing supervision fixture")
  mission.supervision.originalAcceptance = ["Reject non-object IPC roots and preserve valid object requests"]
  mission.fingerprint = fingerprint
  mission.initialFingerprint = "original-ipc-worktree"
  mission.executionPolicy = executionPolicySchema.parse({ maxRuns: 200 })
  mission.execution = { startedAt: new Date().toISOString(), runsStarted: 17, retries: 0, crashRestarts: 0 }
  mission.operatingPolicy = {
    memory: false,
    reviewVendor: "prefer",
    readyActors: ["codex", "qwen", "opencode"],
    routing: {
      minSamples: 3,
      minSuccessRate: 0.8,
      candidates: [
        { actorType: "codex", inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
        { actorType: "qwen", inputPerMillionUsd: 2, outputPerMillionUsd: 2 },
        { actorType: "opencode", inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
      ],
    },
  }
  mission.operations = {
    runs: [priorWork()],
    reviewDecisions: [],
    routingEvidence: [
      { actorType: "codex", samples: 3, successes: 0, totalCostUsd: 0.03, successfulDeliverableCostUsd: null },
      { actorType: "qwen", samples: 3, successes: 2, totalCostUsd: 0.02, successfulDeliverableCostUsd: 0.01 },
      { actorType: "opencode", samples: 2, successes: 0, totalCostUsd: 0, successfulDeliverableCostUsd: null },
    ],
  }
  const state = mission.tasks[0]
  if (!state) throw new Error("Missing repair state")
  applyTaskReviewResult(
    mission,
    state,
    parseReview(
      JSON.stringify({ passed: false, summary: "The derived Request accepts positional arrays", findings: [finding] }),
    ),
  )
  mission.history.push({ at: new Date().toISOString(), stage: "review", taskId: state.id, message: finding })
  store = new MissionStore(join(directory, "records"))
})

afterEach(async () => {
  await runtime?.close()
  await rm(directory, { recursive: true, force: true })
})

function adapter() {
  const spawn = vi.fn<AgentRunnerPort["spawn"]>(async (input: SpawnInput): Promise<RunHandle> => {
    if (!input.attempt) throw new Error("Missing native attempt")
    const result: RunAttempt = {
      ...input.attempt,
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      agentOutput: "Added the object-envelope guard and negative frame regression evidence",
      tokenUsage: { input: 120, output: 40, model: input.model ?? "reported-native-model" },
    }
    return {
      attemptId: input.attemptId,
      issueKey: input.issue.identifier,
      result: Promise.resolve(result),
      executionCapabilities: { cancellation: "unsupported", forceStop: false, reconnect: true },
      isAlive: () => false,
      cancel: vi.fn(async () => {}),
      kill: vi.fn(async () => {}),
      onEvent: () => () => {},
      send: vi.fn(async () => {}),
    }
  })
  const runner = { spawn, capabilities: () => [] } satisfies AgentRunnerPort
  runtime = new ChiefRuntime(store, undefined, undefined, undefined, runner)
  return { spawn, runner, ports: { ...runtime.ports(), fingerprint: async () => fingerprint } satisfies ChiefPorts }
}

describe("bounded routing recovery through native runtime dispatch", () => {
  it("dispatches the retained IPC repair through the best measured route and reserves only call 18", async () => {
    const { spawn, ports } = adapter()
    if (!mission.executionPolicy) throw new Error("Missing execution policy")
    mission.executionPolicy.maxRuns = 18
    const goal = mission.goal
    const roster = structuredClone(mission.personas)
    const quality = routeEvidence(mission)
    const routing = structuredClone(mission.operatingPolicy?.routing)
    expect(quality.map((entry) => [entry.actorType, entry.samples, entry.successes])).toEqual([
      ["codex", 3, 0],
      ["qwen", 3, 2],
      ["opencode", 3, 0],
    ])

    const result = await coordinate(mission, ports)

    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ agentType: "qwen" })
    expect(spawn.mock.calls[0]?.[0].prompt).toContain(JSON.stringify(finding))
    const saved = await store.load(mission.id)
    expect(saved.execution).toMatchObject({ runsStarted: 18, retries: 0, crashRestarts: 0, failureKind: "budget" })
    expect(result.status).toBe("paused")
    expect(saved.tasks[0]).toMatchObject({ repairRound: 1, status: "reviewing" })
    expect(saved.operations?.runs.at(-1)).toMatchObject({
      actorType: "qwen",
      stage: "work",
      executionState: "settled",
      outcome: "pending",
      inputTokens: 120,
      outputTokens: 40,
    })
    expect(saved.operations?.runs.at(-1)?.routingReason).toMatch(/^Bounded routing probe /)
    expect(saved.operations?.runs[0]?.outcome).toBe("rejected")
    expect(routeEvidence(saved)).toEqual(quality)
    expect(saved.operatingPolicy?.routing).toEqual(routing)
    expect(saved.personas).toEqual(roster)
    expect(saved.goal).toBe(goal)
    expect(saved.maxRepairs).toBe(2)
  })

  it("allows the first best-measured probe for another task after a runtime restart instead of closing the whole mission pool", async () => {
    const { spawn, runner, ports } = adapter()
    const run = createMissionRun(
      mission,
      ports,
      () => {},
      () => {},
    )
    const first = task()
    const state = mission.tasks[0]
    if (!state) throw new Error("Missing repair state")
    await run(worker(), workPrompt(mission, first, state, worker()), "work", first.id)
    const restored = await store.load(mission.id)
    const next = { ...first, id: "task-resident", title: "Implement resident IPC regression", dependencies: [] }
    restored.plan?.tasks.push(next)
    restored.tasks.push({ id: next.id, status: "pending", attempts: 0, reviewerId: "reviewer" })
    await runtime?.close()
    runtime = new ChiefRuntime(store, undefined, undefined, undefined, runner)
    const resumed = createMissionRun(
      restored,
      { ...runtime.ports(), fingerprint: async () => fingerprint },
      () => {},
      () => {},
    )

    await resumed(worker(restored), "Continue the next saved task", "work", next.id)

    expect(spawn.mock.calls.map(([input]) => input.agentType)).toEqual(["qwen", "qwen"])
    const saved = await store.load(mission.id)
    const reasons = saved.operations?.runs
      .filter((entry) => entry.routingReason?.startsWith("Bounded routing probe "))
      .map((entry) => entry.routingReason?.split(": ")[0])
    expect(reasons).toHaveLength(2)
    expect(new Set(reasons).size).toBe(2)
    expect(saved.execution?.runsStarted).toBe(19)
    expect(saved.operations?.runs[0]?.outcome).toBe("rejected")
    expect(routeEvidence(saved).map((entry) => [entry.actorType, entry.samples, entry.successes])).toEqual([
      ["codex", 3, 0],
      ["qwen", 3, 2],
      ["opencode", 3, 0],
    ])
  })

  it("does not repeat a settled pending probe with lost output when parallel success makes its route qualified", async () => {
    const { spawn, runner, ports } = adapter()
    const run = createMissionRun(
      mission,
      ports,
      () => {},
      () => {},
    )
    await run(worker(), "Repair the saved IPC finding", "work", "task-ipc")
    const restored = await store.load(mission.id)
    const pending = restored.operations?.runs.at(-1)
    const quality = restored.operations?.routingEvidence.find((entry) => entry.actorType === "qwen")
    const state = restored.tasks[0]
    if (!pending || !quality || !state) throw new Error("Missing settled probe fixture")
    expect(pending).toMatchObject({ actorType: "qwen", executionState: "settled", outcome: "pending" })
    expect(pending.routingReason).toMatch(/^Bounded routing probe /)
    delete state.output
    quality.samples = 10
    quality.successes = 10
    quality.totalCostUsd = 0.04
    quality.successfulDeliverableCostUsd = 0.004
    await store.save(restored)
    expect(routeEvidence(restored).find((entry) => entry.actorType === "qwen")).toMatchObject({
      samples: 10,
      successes: 10,
    })
    const originalProbe = structuredClone(pending)
    await runtime?.close()
    spawn.mockClear()
    runtime = new ChiefRuntime(store, undefined, undefined, undefined, runner)
    const resumed = createMissionRun(
      restored,
      { ...runtime.ports(), fingerprint: async () => fingerprint },
      () => {},
      () => {},
    )

    await expect(
      resumed(worker(restored), "Resume the same unresolved IPC checkpoint", "work", "task-ipc"),
    ).rejects.toThrow("unreviewed bounded routing probe")

    expect(spawn).not.toHaveBeenCalled()
    expect(restored.operations?.runs.at(-1)).toEqual(originalProbe)
    expect(restored.operations?.runs).toHaveLength(2)
    expect(state.output).toBeUndefined()
    expect(state.review?.passed).toBe(false)
    expect(restored.operatingPolicy?.routing?.minSuccessRate).toBe(0.8)
  })

  it.each(["unknown-execution", "unknown-effect", "spent-calls", "spent-cost", "unknown-cost"] as const)(
    "does not dispatch a probe through the %s barrier or erase the rejection",
    async (barrier) => {
      const { spawn, ports } = adapter()
      const previous = mission.operations?.runs[0]
      const policy = mission.executionPolicy
      const first = mission.plan?.tasks[0]
      const state = mission.tasks[0]
      if (!previous || !policy || !first || !state) throw new Error("Missing guarded fixture")
      if (barrier === "unknown-execution")
        mission.operations?.runs.push({
          ...previous,
          runId: "unreconciled-report",
          actorId: mission.chiefId,
          actorType: "grok",
          stage: "report",
          taskId: undefined,
          finishedAt: null,
          outcome: "pending",
          executionState: "unknown",
        })
      if (barrier === "unknown-effect") {
        first.effectScope = "external"
        state.effectState = "unknown"
      }
      if (barrier === "spent-calls") policy.maxRuns = 17
      if (barrier === "spent-cost") policy.maxEstimatedCostUsd = previous.costUsd ?? 0.004
      if (barrier === "unknown-cost") {
        previous.costUsd = null
        policy.maxEstimatedCostUsd = 1
      }
      const quality = routeEvidence(mission)
      const review = structuredClone(state.review)

      const result = await coordinate(mission, ports)

      expect(spawn).not.toHaveBeenCalled()
      expect(result.status).toBe("paused")
      expect(mission.execution?.runsStarted).toBe(17)
      expect(mission.operations?.runs[0]?.outcome).toBe("rejected")
      expect(routeEvidence(mission)).toEqual(quality)
      expect(state.review).toEqual(review)
      expect(state.repairRound).toBe(1)
    },
  )
})
