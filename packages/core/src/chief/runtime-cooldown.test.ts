import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RunAttempt } from "../domain/models"
import { AgentRunError, type AgentRunnerPort, type RunHandle, type SpawnInput } from "../domain/ports/agent-runner"
import { validateOmaEvidence } from "../oma/receipt-adapter"
import * as worktreeLifecycle from "../workspace/worktree-lifecycle"
import { actorRouteHealth } from "./actor-health"
import { executionPolicySchema } from "./contracts"
import { coordinate } from "./coordinator"
import { createMissionRun } from "./coordinator-run"
import { MissionPause } from "./execution"
import { brief, fixture, plan } from "./goal-supervision.fixture"
import type { OperatingRun } from "./operations"
import { selectTaskReviewer } from "./review-routing"
import { routeEvidence, selectWorkActor } from "./routing"
import { ChiefRuntime } from "./runtime"
import { finalCriteria } from "./schemas"
import { MissionStore } from "./store"
import type { ChiefPorts, Mission, Persona } from "./types"

vi.mock("../oma/receipt-adapter", () => ({
  prepareOmaAttempt: vi.fn(async () => "prepared-plan.json"),
  buildOmaGuidance: vi.fn(() => "Receipt fixture"),
  validateOmaEvidence: vi.fn(() => ({ ok: true, runId: "receipt" })),
}))

const now = Date.parse("2026-11-10T12:00:00.000Z")
let directory: string
let mission: Mission
let store: MissionStore
let runtime: ChiefRuntime | undefined
const at = (offset = 0) => new Date(now + offset).toISOString()
function actor(id = "worker", current = mission): Persona {
  const selected = current.personas.find((entry) => entry.id === id)
  if (!selected) throw new Error(`Missing Actor ${id}`)
  return selected
}
function failure(actorType: string, age = 1_000, model?: string): OperatingRun {
  return {
    runId: `${actorType}-${model ?? "default"}`,
    taskId: "earlier-task",
    stage: "work",
    actorId: "earlier-worker",
    actorType,
    model,
    startedAt: at(-age - 1_000),
    finishedAt: at(-age),
    elapsedMs: 1_000,
    inputTokens: 100,
    outputTokens: 20,
    costUsd: 0.01,
    outcome: "failed",
    nativeOutcome: "failed",
    executionState: "settled",
    executionRecovery: "local-process",
    evidence: "Agent timed out after 1800s",
  }
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(now)
  directory = await mkdtemp(join(tmpdir(), "chief-runtime-cooldown-"))
  mission = fixture().mission
  mission.workspace.path = directory
  mission.availableSkills = []
  mission.availableAgents = ["qwen", "opencode", "codex", "grok"]
  actor("chief").agentType = "grok"
  actor("chief").model = "original-chief-model"
  actor().agentType = "qwen"
  actor("reviewer").agentType = "qwen"
  mission.personas.push({
    id: "codex-reviewer",
    name: "Independent reviewer",
    role: "Review acceptance",
    agentType: "codex",
    skills: [],
  })
  mission.plan = structuredClone(plan)
  mission.goalBrief = structuredClone(brief)
  if (!mission.supervision) throw new Error("Missing supervision")
  mission.supervision.originalAcceptance = plan.tasks.flatMap((task) => task.acceptance)
  mission.tasks = [{ id: "onboarding", status: "pending", attempts: 0, reviewerId: "reviewer" }]
  mission.executionPolicy = executionPolicySchema.parse({ maxRuns: 200, maxDurationSec: 86_400 })
  mission.execution = { startedAt: at(-3_600_000), runsStarted: 17, retries: 2, crashRestarts: 0 }
  mission.operatingPolicy = {
    reviewVendor: "prefer",
    memory: false,
    readyActors: ["qwen", "opencode", "codex"],
    routing: {
      minSamples: 3,
      minSuccessRate: 0.8,
      candidates: [
        { actorType: "qwen", inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
        { actorType: "opencode", inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
        { actorType: "codex", inputPerMillionUsd: 2, outputPerMillionUsd: 2 },
      ],
    },
  }
  mission.operations = { runs: [failure("qwen"), failure("opencode")], routingEvidence: [], reviewDecisions: [] }
  store = new MissionStore(join(directory, "records"))
  vi.mocked(validateOmaEvidence).mockReset().mockReturnValue({ ok: true, runId: "receipt" })
})
afterEach(async () => {
  await runtime?.close()
  runtime = undefined
  vi.restoreAllMocks()
  vi.useRealTimers()
  await rm(directory, { recursive: true, force: true })
})
function completed(input: SpawnInput, exitCode = 0): RunAttempt {
  if (!input.attempt) throw new Error("Missing native attempt")
  return {
    ...input.attempt,
    finishedAt: at(),
    exitCode,
    agentOutput: "Saved acceptance evidence",
    tokenUsage: { input: 100, output: 20, model: input.model ?? "reported-default" },
  }
}
function handle(input: SpawnInput, result: Promise<RunAttempt>): RunHandle {
  void result.catch(() => {})
  return {
    attemptId: input.attemptId,
    issueKey: input.issue.identifier,
    result,
    executionCapabilities: { cancellation: "confirmed", forceStop: false, reconnect: true },
    isAlive: () => false,
    cancel: vi.fn(async () => {}),
    kill: vi.fn(async () => {}),
    onEvent: () => () => {},
    send: vi.fn(async () => {}),
  }
}

function adapter(result: (input: SpawnInput) => Promise<RunAttempt> = async (input) => completed(input)) {
  const spawn = vi.fn<AgentRunnerPort["spawn"]>(async (input) => handle(input, result(input)))
  const runner = { spawn, capabilities: () => [] } satisfies AgentRunnerPort
  runtime = new ChiefRuntime(store, undefined, undefined, undefined, runner)
  const ports: ChiefPorts = { ...runtime.ports(), fingerprint: async () => "retained-files", verify: vi.fn() }
  const run = createMissionRun(
    mission,
    ports,
    () => {},
    () => {},
  )
  return { spawn, ports, run }
}

describe("native cooldown admission and routing", () => {
  it("skips both cooling vendors for work and preserves independent same-vendor review under prefer", async () => {
    const { spawn, run } = adapter()
    const chief = structuredClone(actor("chief"))
    await run(actor(), "Implement the task", "work", "onboarding")
    const task = mission.plan?.tasks[0]
    const state = mission.tasks[0]
    if (!task || !state) throw new Error("Missing task")
    const reviewer = selectTaskReviewer(mission, task, state)
    expect(reviewer).toMatchObject({ id: "codex-reviewer", agentType: "codex" })
    await run(reviewer, "Independently inspect saved files", "review", task.id)
    expect(spawn.mock.calls.map(([input]) => input.agentType)).toEqual(["codex", "codex"])
    expect(mission.operations?.reviewDecisions.at(-1)).toMatchObject({
      crossVendor: false,
      workerActorType: "codex",
      reviewerId: "codex-reviewer",
    })
    expect(actor("chief")).toEqual(chief)
  })

  it("waits for the independent vendor under require instead of weakening review policy", () => {
    const state = mission.tasks[0]
    const task = mission.plan?.tasks[0]
    if (!state || !task || !mission.operatingPolicy) throw new Error("Missing policy")
    mission.operatingPolicy.reviewVendor = "require"
    actor().agentType = "codex"
    const roster = structuredClone(mission.personas)
    try {
      selectTaskReviewer(mission, task, state)
      throw new Error("Expected cooldown pause")
    } catch (error) {
      expect(error).toBeInstanceOf(MissionPause)
      expect(error).toMatchObject({ kind: "actor-cooldown", nextRunAt: at(14 * 60_000 + 59_000) })
    }
    expect(state.reviewerId).toBe("reviewer")
    expect(mission.personas).toEqual(roster)
    expect(mission.operatingPolicy.reviewVendor).toBe("require")
  })

  it.each(["explicit-model", "saved-handoff"] as const)("cannot bypass admission through %s", async (mode) => {
    if (!mission.operations) throw new Error("Missing operations")
    if (mode === "explicit-model") {
      delete mission.availableAgents
      actor().model = "pinned-model"
      mission.operations.runs.push(failure("qwen", 1_000, "pinned-model"))
    } else {
      actor().agentType = "codex"
      mission.handoff = { exhaustedAgents: [], routes: { worker: { agentType: "qwen" } }, continuations: {} }
    }
    const before = structuredClone(mission.execution)
    const { spawn, run } = adapter()
    await expect(run(actor(), "Continue the saved assignment", "work", "onboarding")).rejects.toMatchObject({
      kind: "actor-cooldown",
    })
    expect(spawn).not.toHaveBeenCalled()
    expect(mission.execution).toEqual(before)
    expect(mission.operations.runs).toHaveLength(mode === "explicit-model" ? 3 : 2)
  })

  it("returns a durable coordinator waiting checkpoint without spending calls, retries, money or recovery rounds", async () => {
    if (!mission.operations || !mission.executionPolicy) throw new Error("Missing operations")
    mission.executionPolicy.maxEstimatedCostUsd = 10
    mission.operations.runs.push(failure("codex"))
    const spent = structuredClone(mission.execution)
    const runs = structuredClone(mission.operations.runs)
    const limits = structuredClone(mission.executionPolicy)
    const goal = mission.goal
    const { spawn, ports } = adapter()
    const result = await coordinate(mission, ports)
    expect(result.status).toBe("waiting")
    const saved = await store.load(mission.id)
    expect(saved.execution).toMatchObject({
      ...spent,
      failureKind: "actor-cooldown",
      nextRunAt: at(14 * 60_000 + 59_000),
    })
    expect(saved.operations?.runs).toEqual(runs)
    expect(saved.executionPolicy).toEqual(limits)
    expect(saved.goal).toBe(goal)
    expect(saved.supervision).toMatchObject({ rounds: 0, stalledRounds: 0, decisions: [] })
    expect(spawn).not.toHaveBeenCalled()
    expect(ports.verify).not.toHaveBeenCalled()
    const before = structuredClone(saved)
    await coordinate(saved, ports)
    expect(saved.execution).toEqual(before.execution)
    expect(spawn).not.toHaveBeenCalled()
  })

  it("carries health through measured route evidence into an independently created child and replacement task", () => {
    const seeded = routeEvidence(mission)
    const child = structuredClone(mission)
    child.id = "next-child"
    child.operations = { runs: [], routingEvidence: structuredClone(seeded), reviewDecisions: [] }
    const original = plan.tasks[0]
    if (!original) throw new Error("Missing original task")
    child.plan = { tasks: [{ ...original, id: "replacement" }] }
    const selection = selectWorkActor(child, actor("worker", child), "replacement")
    expect(selection.actor.agentType).toBe("codex")
    expect(actorRouteHealth(child, { actorType: "qwen" })).toMatchObject({ state: "cooling", consecutiveFailures: 1 })
    expect(child.operations.routingEvidence).toEqual(seeded)
    expect(child.operations.runs).toEqual([])
  })

  it("admits exactly one half-open native call during a parallel race, then restores healthy parallelism", async () => {
    if (!mission.operations || !mission.operatingPolicy?.routing) throw new Error("Missing routing")
    mission.operations.runs = [failure("codex", 16 * 60_000)]
    mission.operatingPolicy.routing.candidates = [{ actorType: "codex", inputPerMillionUsd: 2, outputPerMillionUsd: 2 }]
    let release: () => void = () => {}
    let announce: () => void = () => {}
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const spawned = new Promise<void>((resolve) => {
      announce = resolve
    })
    const { spawn, run } = adapter(async (input) => {
      announce()
      await pending
      return completed(input)
    })
    const both = Promise.allSettled([
      run(actor(), "Probe recovery A", "work", "probe-a"),
      run(actor(), "Probe recovery B", "work", "probe-b"),
    ])
    await spawned
    expect(spawn).toHaveBeenCalledOnce()
    expect(mission.execution?.runsStarted).toBe(18)
    release()
    const outcomes = await both
    expect(outcomes.filter((entry) => entry.status === "fulfilled")).toHaveLength(1)
    expect(outcomes.find((entry) => entry.status === "rejected")).toMatchObject({ reason: { kind: "actor-cooldown" } })
    expect(actorRouteHealth(mission, { actorType: "codex" })).toMatchObject({ state: "ready", consecutiveFailures: 0 })
    await Promise.all([run(actor(), "Healthy A", "work", "healthy-a"), run(actor(), "Healthy B", "work", "healthy-b")])
    expect(spawn).toHaveBeenCalledTimes(3)
    expect(mission.execution).toMatchObject({ runsStarted: 20, retries: 2 })
    expect(
      (await store.load(mission.id)).operations?.runs.filter((entry) => entry.executionState === "running"),
    ).toEqual([])
  })

  it("records native success when AV rejects the OMA receipt rather than cooling a functioning CLI", async () => {
    mission.oma = true
    vi.spyOn(worktreeLifecycle, "runCommand").mockResolvedValue({
      exitCode: 0,
      stdout: `${"a".repeat(40)}\n`,
      stderr: "",
    })
    vi.mocked(validateOmaEvidence).mockReturnValueOnce({ ok: false, reason: "Missing completion receipt" })
    const { spawn, ports } = adapter()
    await expect(
      ports.runAgent(actor(), "Implement the task", mission, "work", {
        taskId: "onboarding",
        omaActor: { agentId: "backend-engineer", guidance: "Role fixture", skills: ["oma-backend"], digest: "fixture" },
      }),
    ).rejects.toThrow("OMA completion evidence failed")
    expect(spawn).toHaveBeenCalledOnce()
    const saved = await store.load(mission.id)
    expect(saved.operations?.runs.at(-1)).toMatchObject({
      actorType: "codex",
      outcome: "failed",
      nativeOutcome: "passed",
      executionState: "settled",
    })
    expect(actorRouteHealth(saved, { actorType: "codex" })).toMatchObject({ state: "ready", consecutiveFailures: 0 })
  })

  it("retains spent usage for confirmed operator cancellation without recording an Actor health or quality failure", async () => {
    const controller = new AbortController()
    let announce: () => void = () => {}
    const spawned = new Promise<void>((resolve) => {
      announce = resolve
    })
    const spawn = vi.fn<AgentRunnerPort["spawn"]>(async (input) => {
      let reject: (error: Error) => void = () => {}
      const result = new Promise<RunAttempt>((_resolve, rejectResult) => {
        reject = rejectResult
      })
      const execution = handle(input, result)
      let alive = true
      execution.isAlive = () => alive
      execution.cancel = vi.fn(async () => {
        alive = false
        reject(new AgentRunError("Operator stopped the order", completed(input, 130)))
      })
      announce()
      return execution
    })
    runtime = new ChiefRuntime(store, controller.signal, undefined, undefined, { spawn, capabilities: () => [] })
    const ports = { ...runtime.ports(), fingerprint: async () => "retained-files" }
    const run = createMissionRun(
      mission,
      ports,
      () => {},
      () => controller.signal.throwIfAborted(),
    )
    const stopped = run(actor(), "Implement the task", "work", "onboarding").catch((error: unknown) => error)
    await spawned
    controller.abort(new MissionPause("Operator requested cancellation", "interrupted"))
    expect(await stopped).toMatchObject({ kind: "interrupted" })
    const saved = await store.load(mission.id)
    expect(saved.operations?.runs.at(-1)).toMatchObject({
      nativeOutcome: "cancelled",
      executionState: "settled",
      outcome: "failed",
      inputTokens: 100,
      outputTokens: 20,
    })
    expect(saved.execution?.runsStarted).toBe(18)
    expect(actorRouteHealth(saved, { actorType: "codex" })).toMatchObject({ state: "ready", consecutiveFailures: 0 })
    expect(routeEvidence(saved).find((route) => route.actorType === "codex")).toMatchObject({
      samples: 0,
      successes: 0,
      totalCostUsd: 0.00024,
    })
  })

  it("keeps an unconfirmed native outcome protected and excludes it from cooldown failure counts", async () => {
    const { spawn, run } = adapter(async (input) => {
      if (!input.attempt) throw new Error("Missing attempt")
      throw new AgentRunError("Remote execution outcome is unknown", input.attempt, { outcomeUnknown: true })
    })
    await expect(run(actor(), "Implement the task", "work", "onboarding")).rejects.toMatchObject({
      kind: "unknown-effect",
    })
    expect(spawn).toHaveBeenCalledOnce()
    const saved = await store.load(mission.id)
    expect(saved.operations?.runs.at(-1)).toMatchObject({
      actorType: "codex",
      outcome: "pending",
      executionState: "unknown",
    })
    expect(saved.operations?.runs.at(-1)?.nativeOutcome).toBeUndefined()
    expect(actorRouteHealth(saved, { actorType: "codex" })).toMatchObject({ state: "unknown", consecutiveFailures: 0 })
    await expect(run(actor(), "Retry must remain blocked", "work", "another-task")).rejects.toMatchObject({
      kind: "unknown-effect",
    })
    expect(mission.execution?.runsStarted).toBe(18)
    expect(spawn).toHaveBeenCalledOnce()
  })

  it.each(["passed", "provider", "unknown"] as const)(
    "refreshes a joined probe wait after %s without hiding the actual terminal outcome",
    async (outcome) => {
      if (!mission.operations || !mission.operatingPolicy?.routing || !mission.executionPolicy)
        throw new Error("Missing routing")
      const original = plan.tasks[0]
      if (!original) throw new Error("Missing task")
      mission.plan = { tasks: ["a", "b"].map((id) => ({ ...original, id })) }
      mission.tasks = ["a", "b"].map((id) => ({ id, status: "pending", attempts: 0, reviewerId: "reviewer" }))
      mission.availableAgents?.push("claude")
      actor("reviewer").agentType = "claude"
      mission.operatingPolicy.readyActors = ["codex", "claude"]
      mission.operatingPolicy.reviewVendor = "require"
      mission.operatingPolicy.routing.candidates = [
        { actorType: "codex", inputPerMillionUsd: 2, outputPerMillionUsd: 2 },
      ]
      mission.executionPolicy.maxParallel = 2
      mission.operations.runs = [failure("codex", 16 * 60_000)]
      let release: () => void = () => {}
      const probe = new Promise<void>((resolve) => {
        release = resolve
      })
      const { spawn, ports } = adapter(async (input) => {
        if (input.stage === "work") {
          await probe
          if (outcome !== "passed")
            throw new AgentRunError(
              outcome === "provider" ? "Agent timed out after 1800s" : "Unknown provider outcome",
              completed(input, 2),
              { outcomeUnknown: outcome === "unknown" },
            )
        }
        const review = {
          passed: true,
          summary: "Independent acceptance passed",
          findings: [],
          criteria: finalCriteria(mission).map((criterion) => ({
            criterion,
            passed: true,
            evidence: "Saved files and passing verification inspected",
          })),
        }
        return {
          ...completed(input),
          agentOutput: input.stage === "work" ? `Delivered ${input.workspace.path}` : JSON.stringify(review),
        }
      })
      const native = ports.runAgent
      let blocked = 0
      ports.runAgent = async (...args) => {
        try {
          return await native(...args)
        } catch (error) {
          if (error instanceof MissionPause && error.kind === "actor-cooldown") {
            blocked += 1
            release()
          }
          throw error
        }
      }
      let version = 0
      ports.fingerprint = async () => `integrated-delivery-${version}`
      ports.parallel = {
        prepare: async (current, taskId, attempt) => ({
          version: 1,
          missionId: current.id,
          taskId,
          attempt,
          sourceWorkspacePath: directory,
          path: join(directory, taskId),
          branch: `task/${taskId}`,
          baselineHead: "a".repeat(40),
          baselineTree: "b".repeat(40),
        }),
        integrate: vi.fn(async () => {
          version += 1
        }),
        dispose: vi.fn(async () => {}),
      }
      ports.verify = vi.fn(async () => ({ ok: true, output: "Verification passed" }))
      const result = await coordinate(mission, ports)
      expect(blocked).toBe(1)
      const work = spawn.mock.calls.filter(([input]) => input.stage === "work")
      if (outcome === "passed") {
        expect(result.status).toBe("completed")
        expect(work.map(([input]) => input.workspace.path)).toEqual([join(directory, "a"), join(directory, "b")])
        expect(mission.tasks.map((state) => [state.id, state.status, state.output])).toEqual([
          ["a", "completed", `Delivered ${join(directory, "a")}`],
          ["b", "completed", `Delivered ${join(directory, "b")}`],
        ])
        expect(
          spawn.mock.calls.filter(([input]) => input.stage === "review").map(([input]) => input.agentType),
        ).toEqual(["claude", "claude"])
        expect(mission.execution).toMatchObject({ runsStarted: 22, retries: 2 })
        expect(mission.execution?.nextRunAt).toBeUndefined()
        expect(ports.verify).toHaveBeenCalledOnce()
      } else {
        expect(work).toHaveLength(1)
        expect(mission.execution).toMatchObject({
          runsStarted: 18,
          retries: outcome === "provider" ? 3 : 2,
          failureKind: outcome === "provider" ? "provider" : "unknown-effect",
        })
        expect(result.status).toBe(outcome === "provider" ? "waiting" : "paused")
        expect(mission.execution?.nextRunAt).toBe(outcome === "provider" ? at(4_000) : undefined)
        expect(ports.verify).not.toHaveBeenCalled()
      }
    },
  )
})
