/**
 * AgentRunnerService unit tests — spawn() lifecycle wiring.
 *
 * Focus: the "spawned" event -> RunCallbacks.onSpawned pid hop (see
 * BaseSession.process setter in ../sessions/base-session.ts). Uses
 * FakeAgentSession so nothing spawns a real subprocess.
 */

import { beforeEach, describe, expect, test, vi } from "vitest"
import type { RunAttempt } from "../domain/models"
import { AgentRunnerService, type RunCallbacks, type RunOptions } from "../orchestrator/agent-runner"
import { registerSession } from "../sessions/session-factory"
import { FakeAgentSession } from "./characterization/helpers"

// Block SessionRegistry.registerBuiltins from clobbering our fake registration.
vi.mock("../sessions/session-factory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sessions/session-factory")>()
  return {
    ...actual,
    registerBuiltinSessions: vi.fn(async () => undefined),
  }
})

function makeAttempt(overrides: Partial<RunAttempt> = {}): RunAttempt {
  return {
    id: "att-1",
    issueId: "issue-1",
    workspacePath: "/tmp/ws",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    agentOutput: null,
    ...overrides,
  }
}

function makeOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    agentType: "claude",
    timeout: 30,
    prompt: "do the thing",
    workspacePath: "/tmp/ws",
    ...overrides,
  }
}

function makeCallbacks(overrides: Partial<RunCallbacks> = {}): RunCallbacks {
  return {
    onComplete: vi.fn(),
    onError: vi.fn(),
    onHeartbeat: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  FakeAgentSession.resetRegistry()
  registerSession("claude", () => new FakeAgentSession())
})

describe("AgentRunnerService.spawn — pid propagation", () => {
  test("forwards the session's 'spawned' event pid to callbacks.onSpawned", async () => {
    const runner = new AgentRunnerService()
    const onSpawned = vi.fn()

    await runner.spawn(makeAttempt(), makeOptions(), makeCallbacks({ onSpawned }))

    const session = FakeAgentSession.instances[0]
    expect(session).toBeDefined()
    session?.emit("spawned", { type: "spawned", pid: 4242 })

    expect(onSpawned).toHaveBeenCalledWith(4242)
  })

  test("forwards undefined pid when spawn() itself failed to obtain one", async () => {
    const runner = new AgentRunnerService()
    const onSpawned = vi.fn()

    await runner.spawn(makeAttempt(), makeOptions(), makeCallbacks({ onSpawned }))

    const session = FakeAgentSession.instances[0]
    session?.emit("spawned", { type: "spawned", pid: undefined })

    expect(onSpawned).toHaveBeenCalledWith(undefined)
  })

  test("does not throw when the caller omits onSpawned", async () => {
    const runner = new AgentRunnerService()

    await runner.spawn(makeAttempt(), makeOptions(), makeCallbacks())

    const session = FakeAgentSession.instances[0]
    expect(() => session?.emit("spawned", { type: "spawned", pid: 1 })).not.toThrow()
  })

  test("onComplete still fires once even after a 'spawned' event was observed mid-run", async () => {
    const runner = new AgentRunnerService()
    const onSpawned = vi.fn()
    const onComplete = vi.fn()

    await runner.spawn(makeAttempt(), makeOptions(), makeCallbacks({ onSpawned, onComplete }))

    const session = FakeAgentSession.instances[0]
    session?.emit("spawned", { type: "spawned", pid: 999 })
    session?.emit("complete", {
      type: "complete",
      result: { exitCode: 0, output: "done", durationMs: 10, filesChanged: [] },
    })

    expect(onSpawned).toHaveBeenCalledOnce()
    expect(onSpawned).toHaveBeenCalledWith(999)
    expect(onComplete).toHaveBeenCalledOnce()
  })
})
