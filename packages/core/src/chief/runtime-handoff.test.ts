import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RunAttempt } from "../domain/models"
import { AgentRunError, type AgentRunnerPort, type RunHandle, type SpawnInput } from "../domain/ports/agent-runner"
import type { SkillMatrixDeps } from "../oma/skill-matrix-adapter"
import { executionPolicySchema } from "./contracts"
import { createMissionRun } from "./coordinator-run"
import { fixture, plan } from "./goal-supervision.fixture"
import { ChiefRuntime } from "./runtime"
import { MissionStore } from "./store"
import type { Mission, Persona } from "./types"

let directory: string
let mission: Mission
let store: MissionStore
let runtime: ChiefRuntime | undefined

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "chief-runtime-handoff-"))
  mission = fixture().mission
  mission.workspace.path = directory
  mission.availableSkills = []
  mission.plan = structuredClone(plan)
  mission.executionPolicy = executionPolicySchema.parse({ maxRuns: 10 })
  mission.operatingPolicy = {
    reviewVendor: "prefer",
    memory: false,
    readyActors: ["codex", "claude"],
    routing: {
      minSamples: 3,
      minSuccessRate: 0.8,
      candidates: [
        { actorType: "codex", model: "cheap", inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
        { actorType: "claude", model: "careful", inputPerMillionUsd: 3, outputPerMillionUsd: 6 },
      ],
    },
  }
  actor("reviewer").model = "configured-claude"
  store = new MissionStore(join(directory, "records"))
})

afterEach(async () => {
  await runtime?.close()
  await rm(directory, { recursive: true, force: true })
})

function actor(id: string, current = mission): Persona {
  const selected = current.personas.find((entry) => entry.id === id)
  if (!selected) throw new Error(`Missing fixture Actor ${id}`)
  return selected
}

function completed(input: SpawnInput, exitCode = 0): RunAttempt {
  if (!input.attempt) throw new Error("Missing caller attempt")
  return {
    ...input.attempt,
    finishedAt: new Date().toISOString(),
    exitCode,
    agentOutput: "Observed native fixture output",
    tokenUsage: { input: 100, output: 20, model: input.model ?? "native-default" },
  }
}

function handle(input: SpawnInput, result: Promise<RunAttempt>): RunHandle {
  void result.catch(() => {})
  return {
    attemptId: input.attemptId,
    issueKey: input.issue.identifier,
    result,
    executionCapabilities: { cancellation: "unsupported", forceStop: false, reconnect: true },
    isAlive: () => false,
    cancel: vi.fn(async () => {}),
    kill: vi.fn(async () => {}),
    onEvent: () => () => {},
    send: vi.fn(async () => {}),
  }
}

function missionRun(current = mission) {
  if (!runtime) throw new Error("Missing runtime")
  const ports = { ...runtime.ports(), fingerprint: async () => "unchanged-fixture" }
  return createMissionRun(
    current,
    ports,
    () => {},
    () => {},
  )
}

function runnerWithExhaustedCodex() {
  const executions: RunHandle[] = []
  const spawn = vi.fn<AgentRunnerPort["spawn"]>(async (input) => {
    const result =
      input.agentType === "codex"
        ? Promise.reject(new AgentRunError("usage_limit_reached", completed(input, 2)))
        : Promise.resolve(completed(input))
    const execution = handle(input, result)
    executions.push(execution)
    return execution
  })
  return { runner: { spawn, capabilities: () => [] } satisfies AgentRunnerPort, spawn, executions }
}

describe("native runtime exhaustion handoff", () => {
  it("uses a detected handoff provider for later tasks when every configured route is exhausted", async () => {
    const { runner, spawn } = runnerWithExhaustedCodex()
    if (!mission.operatingPolicy?.routing) throw new Error("Missing routing policy")
    mission.operatingPolicy.routing.candidates = mission.operatingPolicy.routing.candidates.filter(
      (route) => route.actorType === "codex",
    )
    const another = { ...actor("worker"), id: "another-worker" }
    mission.personas.push(another)
    runtime = new ChiefRuntime(store, undefined, undefined, undefined, runner, async () => ["codex", "claude"])
    const run = missionRun()
    await run(actor("worker"), "Implement onboarding", "work", "onboarding")
    await run(another, "Continue with another task", "work", "follow-up")
    expect(spawn.mock.calls.map(([input]) => input.agentType)).toEqual(["codex", "claude", "claude"])
    expect(spawn.mock.calls[2]?.[0].model).toBe("configured-claude")
  })

  it("hands off the actual failed cost route, preserves usage and avoids that provider for another Actor", async () => {
    const { runner, spawn, executions } = runnerWithExhaustedCodex()
    const discover = vi.fn(async () => ["codex", "claude"])
    runtime = new ChiefRuntime(store, undefined, undefined, undefined, runner, discover)
    const anotherWorker = { ...actor("worker"), id: "another-worker", name: "Another worker" }
    mission.personas.push(anotherWorker)
    const originalRoster = structuredClone(mission.personas)
    const run = missionRun()

    await expect(run(actor("worker"), "Implement onboarding", "work", "onboarding")).resolves.toContain(
      "Observed native fixture output",
    )

    expect(spawn.mock.calls.map(([input]) => [input.agentType, input.model])).toEqual([
      ["codex", "cheap"],
      ["claude", "configured-claude"],
    ])
    expect(discover).toHaveBeenCalledOnce()
    const saved = await store.load(mission.id)
    expect(saved.execution?.runsStarted).toBe(2)
    expect(saved.personas).toEqual(originalRoster)
    expect(saved.handoff?.exhaustedAgents).toEqual(["codex"])
    expect(saved.handoff?.routes.worker).toEqual({ agentType: "claude", model: "configured-claude" })
    expect(saved.operations?.runs).toMatchObject([
      { actorType: "codex", model: "cheap", outcome: "failed", inputTokens: 100, outputTokens: 20 },
      { actorType: "claude", model: "configured-claude", outcome: "pending", inputTokens: 100, outputTokens: 20 },
    ])
    expect(spawn.mock.calls[1]?.[0].prompt).toContain("Saved checkpoint")

    await run(anotherWorker, "Implement another isolated task", "work", "follow-up")

    expect(spawn).toHaveBeenCalledTimes(3)
    expect(spawn.mock.calls[2]?.[0]).toMatchObject({ agentType: "claude", model: "careful" })
    expect((await store.load(mission.id)).execution?.runsStarted).toBe(3)
    for (const execution of executions) {
      expect(execution.send).not.toHaveBeenCalled()
      expect(execution.cancel).not.toHaveBeenCalled()
      expect(execution.kill).not.toHaveBeenCalled()
    }
  })

  it("uses the saved Chief handoff provider and its model on later native stages without changing selection", async () => {
    const { runner, spawn, executions } = runnerWithExhaustedCodex()
    const discover = vi.fn(async () => ["codex", "claude"])
    runtime = new ChiefRuntime(store, undefined, undefined, undefined, runner, discover)
    const selectedChief = structuredClone(actor(mission.chiefId))

    await missionRun()(actor(mission.chiefId), "Plan the goal", "plan")
    const resumed = await store.load(mission.id)
    await missionRun(resumed)(actor(resumed.chiefId, resumed), "Assess final evidence", "final-review")

    expect(spawn.mock.calls.map(([input]) => [input.agentType, input.model])).toEqual([
      ["codex", "operator-model"],
      ["claude", "configured-claude"],
      ["claude", "configured-claude"],
    ])
    expect(discover).toHaveBeenCalledOnce()
    const saved = await store.load(mission.id)
    expect(actor(saved.chiefId, saved)).toEqual(selectedChief)
    expect(saved.handoff?.routes.chief).toEqual({ agentType: "claude", model: "configured-claude" })
    expect(saved.execution?.runsStarted).toBe(3)
    expect(saved.operations?.runs.at(-1)).toMatchObject({
      actorId: "chief",
      actorType: "claude",
      model: "configured-claude",
      actualModel: "configured-claude",
      outcome: "passed",
    })
    for (const execution of executions) expect(execution.send).not.toHaveBeenCalled()
  })

  it("still requires current skill evidence before launching a saved handoff route", async () => {
    const { runner, spawn } = runnerWithExhaustedCodex()
    actor("worker").skills = ["oma-unmeasured-skill"]
    mission.handoff = {
      exhaustedAgents: ["codex"],
      routes: { worker: { agentType: "claude", model: "configured-claude" } },
      continuations: {},
    }
    if (!mission.operatingPolicy) throw new Error("Missing fixture operating policy")
    mission.operatingPolicy.skillCompatibility = {
      mode: "require",
      reportPath: join(directory, "missing-matrix.json"),
      maxAgeHours: 168,
    }
    const matrix: SkillMatrixDeps = {
      now: Date.now,
      platform: process.platform,
      arch: process.arch,
      readReport: vi.fn(async () => {
        throw new Error("Compatibility evidence unavailable")
      }),
      plan: vi.fn(async () => {
        throw new Error("Must not launch OMA after unavailable evidence")
      }),
      cliVersion: vi.fn(async () => "unused"),
    }
    runtime = new ChiefRuntime(store, undefined, undefined, matrix, runner)

    await expect(missionRun()(actor("worker"), "Continue assigned work", "work", "onboarding")).rejects.toThrow(
      "Skill compatibility required for claude/configured-claude",
    )

    expect(spawn).not.toHaveBeenCalled()
    expect(matrix.readReport).toHaveBeenCalledOnce()
    expect(matrix.plan).not.toHaveBeenCalled()
    expect(mission.handoff.routes.worker).toEqual({ agentType: "claude", model: "configured-claude" })
  })
})
