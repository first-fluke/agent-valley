import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RunAttempt } from "../domain/models"
import type { RunCallbacks } from "../orchestrator/agent-runner"
import { coordinate } from "./coordinator"
import { brief, fixture, passed, plan, rejected } from "./goal-supervision.fixture"
import { fallbackReport } from "./reports"
import { ChiefRuntime } from "./runtime"
import { finalCriteria } from "./schemas"
import { MissionStore } from "./store"
import type { Mission } from "./types"

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), killAll: vi.fn(async () => {}) }))
vi.mock("../orchestrator/agent-runner", () => ({
  AgentRunnerService: class {
    spawn = mocks.spawn
    killAll = mocks.killAll
  },
}))

let root: string
let mission: Mission
let store: MissionStore
let runtime: ChiefRuntime
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "chief-operation-runtime-"))
  mission = fixture().mission
  mission.workspace.path = root
  mission.operatingPolicy = {
    reviewVendor: "prefer",
    memory: true,
    readyActors: ["codex", "claude", "cursor"],
    routing: {
      minSamples: 3,
      minSuccessRate: 0.8,
      candidates: [
        { actorType: "codex", model: "cheap", inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
        { actorType: "claude", model: "careful", inputPerMillionUsd: 3, outputPerMillionUsd: 6 },
      ],
    },
  }
  store = new MissionStore(join(root, "records"))
  runtime = new ChiefRuntime(store)
  mocks.spawn.mockImplementation(async (attempt: RunAttempt, options: { model?: string }, callbacks: RunCallbacks) => {
    callbacks.onComplete({
      ...attempt,
      finishedAt: new Date(Date.parse(attempt.startedAt) + 1250).toISOString(),
      exitCode: 0,
      agentOutput: "Native fixture result",
      tokenUsage: { input: 1000, output: 2000, model: options.model ?? "reported-default" },
    })
  })
})
afterEach(async () => {
  await runtime.close()
  vi.clearAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe("measured Chief runtime", () => {
  it("passes the selected work model to the native adapter and persists actual measured usage", async () => {
    const worker = mission.personas.find((actor) => actor.id === "worker")
    if (!worker) throw new Error("Missing fixture Actor")
    await runtime.ports().runAgent(worker, "Perform work", mission, "work", { taskId: "onboarding" })
    expect(mocks.spawn.mock.calls[0]?.[1]).toMatchObject({ agentType: "codex", model: "cheap" })
    const saved = await store.load(mission.id)
    expect(saved.operations?.runs[0]).toMatchObject({
      taskId: "onboarding",
      actorType: "codex",
      model: "cheap",
      actualModel: "cheap",
      elapsedMs: 1250,
      inputTokens: 1000,
      outputTokens: 2000,
      costUsd: 0.005,
      outcome: "pending",
    })
    expect(worker.agentType).toBe("cursor")
  })
  it("retains the exact Chief vendor/model for non-work stages and keeps unpriced cost unknown", async () => {
    const chief = mission.personas.find((actor) => actor.id === "chief")
    if (!chief) throw new Error("Missing fixture Chief")
    await runtime.ports().runAgent(chief, "Review evidence", mission, "final-review")
    expect(mocks.spawn.mock.calls[0]?.[1]).toMatchObject({ agentType: "codex", model: "operator-model" })
    expect(mission.operations?.runs[0]).toMatchObject({ stage: "final-review", costUsd: null, outcome: "passed" })
  })
  it("persists partial adapter usage from a failed run without inventing successful evidence", async () => {
    mocks.spawn.mockImplementation(async (_attempt: RunAttempt, _options: unknown, callbacks: RunCallbacks) => {
      callbacks.onError({
        code: "CRASH",
        message: "Synthetic native failure",
        recoverable: true,
        exitCode: 2,
        tokenUsage: { input: 100, output: 200, model: "cheap" },
      })
    })
    const worker = mission.personas.find((actor) => actor.id === "worker")
    if (!worker) throw new Error("Missing fixture Actor")
    await expect(
      runtime.ports().runAgent(worker, "Perform work", mission, "work", { taskId: "onboarding" }),
    ).rejects.toThrow("Synthetic native failure")
    expect((await store.load(mission.id)).operations?.runs[0]).toMatchObject({
      outcome: "failed",
      inputTokens: 100,
      outputTokens: 200,
      costUsd: 0.0005,
    })
  })
  it("ties real review rejection to escalation and chooses the next reviewer against the actual routed vendor", async () => {
    let fingerprint = "initial"
    let work = 0
    let review = 0
    mission.maxRepairs = 1
    mocks.spawn.mockImplementation(
      async (attempt: RunAttempt, options: { model?: string; prompt: string }, callbacks: RunCallbacks) => {
        let output = passed
        if (options.prompt.startsWith("You are the Chief Director coordinating"))
          output = JSON.stringify({ ...plan, goalBrief: brief })
        else if (options.prompt.includes("Your Actor role:")) {
          fingerprint = `change-${++work}`
          output = "Changed onboarding.ts with acceptance evidence"
        } else if (options.prompt.startsWith("Independently review")) output = ++review === 1 ? rejected : passed
        else if (options.prompt.startsWith("Perform the Chief Director"))
          output = JSON.stringify({
            passed: true,
            summary: "Actual criterion evidence",
            findings: [],
            criteria: finalCriteria(mission).map((criterion) => ({
              criterion,
              passed: true,
              evidence: "Inspected onboarding.ts and native check",
            })),
          })
        else if (options.prompt.startsWith("Write the Chief Director")) output = JSON.stringify(fallbackReport(mission))
        callbacks.onComplete({
          ...attempt,
          finishedAt: new Date().toISOString(),
          exitCode: 0,
          agentOutput: output,
          tokenUsage: { input: 1000, output: 2000, model: options.model ?? "reported-default" },
        })
      },
    )
    const ports = runtime.ports()
    ports.fingerprint = async () => fingerprint
    ports.verify = async () => ({ ok: true, output: "Real fixture acceptance gate" })
    const result = await coordinate(mission, ports)
    expect(result.status).toBe("completed")
    const workRuns = result.operations?.runs.filter((run) => run.stage === "work")
    expect(workRuns?.map((run) => [run.actorType, run.outcome])).toEqual([
      ["codex", "rejected"],
      ["claude", "passed"],
    ])
    expect(
      result.operations?.reviewDecisions.map((decision) => [decision.workerActorType, decision.reviewerActorType]),
    ).toEqual([
      ["codex", "claude"],
      ["claude", "codex"],
    ])
    expect(result.personas.find((actor) => actor.id === "chief")?.model).toBe("operator-model")
  })
})
