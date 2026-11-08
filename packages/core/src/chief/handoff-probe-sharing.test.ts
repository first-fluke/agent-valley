import { describe, expect, it, vi } from "vitest"
import { ActorCooldown, refreshActorCooldown } from "./actor-availability"
import { createMissionRun } from "./coordinator-run"
import { createMissionContract } from "./coordinator-state"
import { executionPolicySchema } from "./execution"
import { fixture, passed } from "./goal-supervision.fixture"
import type { OperatingRun } from "./operations"
import type { ChiefTask, Persona } from "./types"

function barrier() {
  let release: () => void = () => {}
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}

function qwenReviewer(): Persona {
  return { id: "review-qwen", name: "Qwen reviewer", role: "Review", agentType: "qwen", skills: [] }
}

function tasks(ids: string[]): ChiefTask[] {
  return ids.map((id) => ({
    id,
    title: id,
    personaId: "chief",
    instructions: `Do ${id}`,
    acceptance: [`${id} done`],
    dependencies: [],
  }))
}

function failedRun(runId: string, actorType: string, at: string): OperatingRun {
  return {
    runId,
    taskId: "task-1",
    stage: "review",
    actorId: `review-${actorType}`,
    actorType,
    startedAt: at,
    finishedAt: at,
    elapsedMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    outcome: "failed",
    executionState: "settled",
    nativeOutcome: "failed",
  }
}

describe("shared in-flight provider handoff", () => {
  it("runs one probe for three concurrent reviews and shares its route without a mission wait", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({ maxParallel: 3 })
    value.mission.operatingPolicy = { reviewVendor: "prefer", memory: false, readyActors: ["codex", "qwen"] }
    value.mission.plan = { tasks: tasks(["task-1", "task-2", "task-3"]) }
    value.mission.personas.push(qwenReviewer())
    value.mission.handoff = { exhaustedAgents: ["qwen"], routes: {}, continuations: {} }
    const discover = vi.fn(async () => ["codex", "qwen", "opencode"])
    value.ports.discoverReadyAgents = discover

    const gate = barrier()
    const started = barrier()
    value.runAgent.mockImplementation(async (actor) => {
      if (actor.agentType === "codex") {
        started.release()
        await gate.wait
        return passed
      }
      throw new Error(`Unexpected review route ${actor.agentType}`)
    })

    const run = createMissionRun(value.mission, value.ports, createMissionContract(value.mission).assert, () => {})
    const reviewer = qwenReviewer()
    const running = Promise.all([
      run(reviewer, "Review", "review", "task-1"),
      run(reviewer, "Review", "review", "task-2"),
      run(reviewer, "Review", "review", "task-3"),
    ])
    await started.wait
    await new Promise((resolve) => setTimeout(resolve, 10))
    gate.release()
    const outputs = await running

    expect(outputs).toEqual([passed, passed, passed])
    // Exactly one discovery probe; the other two reused it.
    expect(discover).toHaveBeenCalledTimes(1)
    expect(value.runAgent.mock.calls.every((call) => call[0].agentType === "codex")).toBe(true)
    expect(value.mission.history.filter((event) => event.stage === "handoff-shared")).toHaveLength(2)
    expect(value.mission.history.some((event) => event.stage === "handoff")).toBe(true)
  })

  it("never holds the mission for an exhausted provider's cooldown", () => {
    const now = new Date().toISOString()
    const value = fixture()
    value.mission.handoff = { exhaustedAgents: ["qwen"], routes: {}, continuations: {} }
    value.mission.operations = {
      runs: [failedRun("claude-fail", "claude", now)],
      routingEvidence: [],
      reviewDecisions: [],
    }
    const nextRunAt = new Date(Date.now() + 60 * 60_000).toISOString()
    const exhausted = new ActorCooldown("qwen cooling", nextRunAt, [{ actorType: "qwen" }])
    expect(refreshActorCooldown(value.mission, exhausted)).toBeUndefined()
    const cooling = new ActorCooldown("claude cooling", nextRunAt, [{ actorType: "claude" }])
    expect(refreshActorCooldown(value.mission, cooling)).toBeInstanceOf(ActorCooldown)
  })
})
