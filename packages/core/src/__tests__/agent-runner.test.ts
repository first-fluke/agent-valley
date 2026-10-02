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
  test.each([
    "complete",
    "error",
    "start",
    "execute",
  ] as const)("disposes the session after %s terminates the run", async (path) => {
    const session = new FakeAgentSession()
    registerSession("claude", () => session)
    if (path === "start" || path === "execute") {
      session[path] = async () => {
        throw new Error(`${path} failed`)
      }
    }
    const runner = new AgentRunnerService()
    await runner.spawn(makeAttempt(), makeOptions(), makeCallbacks())
    if (path === "complete")
      session.emit("complete", {
        type: "complete",
        result: { exitCode: 0, output: "done", durationMs: 1, filesChanged: [] },
      })
    if (path === "error")
      session.emit("error", { type: "error", error: { code: "CRASH", message: "crashed", recoverable: true } })
    await runner.killAll()
    expect(session.disposeCalls).toBeGreaterThanOrEqual(1)
    expect(runner.activeCount).toBe(0)
  })

  test("disposes a process that starts after cancellation finished", async () => {
    const runner = new AgentRunnerService()
    const session = new FakeAgentSession()
    const start = session.start.bind(session)
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    session.start = async (config) => {
      await gate
      await start(config)
    }
    registerSession("claude", () => session)
    const spawning = runner.spawn(makeAttempt(), makeOptions(), makeCallbacks())
    await vi.waitFor(() => expect(runner.activeCount).toBe(1))
    await runner.kill("att-1")
    release?.()
    await spawning
    expect(session.executeCalls).toHaveLength(0)
    expect(session.disposeCalls).toBe(2)
  })

  test("forces disposal when cancel rejects", async () => {
    const runner = new AgentRunnerService()
    await runner.spawn(makeAttempt(), makeOptions(), makeCallbacks())
    const session = FakeAgentSession.instances[0]
    expect(session).toBeDefined()
    if (!session) return
    session.cancel = async () => {
      throw new Error("cancel RPC failed")
    }
    await runner.kill("att-1")
    expect(session.killCalls).toBe(1)
    expect(session.disposeCalls).toBe(1)
  })

  test("concurrent shutdowns await the same cancellation and disposal", async () => {
    const runner = new AgentRunnerService()
    await runner.spawn(makeAttempt(), makeOptions(), makeCallbacks())
    const session = FakeAgentSession.instances[0]
    expect(session).toBeDefined()
    if (!session) return
    let release: (() => void) | undefined
    session.cancel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const first = runner.killAll()
    let secondFinished = false
    const second = runner.killAll().then(() => {
      secondFinished = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(secondFinished).toBe(false)
    expect(session.cancel).toHaveBeenCalledTimes(1)
    release?.()
    await Promise.all([first, second])
    expect(session.killCalls).toBe(1)
    expect(session.disposeCalls).toBe(1)
    expect(secondFinished).toBe(true)
  })

  test("forces disposal after ten seconds when cancel never resolves", async () => {
    vi.useFakeTimers()
    try {
      const runner = new AgentRunnerService()
      await runner.spawn(makeAttempt(), makeOptions(), makeCallbacks())
      const session = FakeAgentSession.instances[0]
      expect(session).toBeDefined()
      if (!session) return
      session.cancel = () => new Promise<void>(() => {})
      const stopping = runner.kill("att-1")
      await vi.advanceTimersByTimeAsync(10_000)
      await stopping
      expect(session.killCalls).toBe(1)
      expect(session.disposeCalls).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test("cancellation while sessions register prevents the first process from starting", async () => {
    const runner = new AgentRunnerService()
    const callbacks = makeCallbacks()
    let release: (() => void) | undefined
    vi.spyOn(runner, "ensureRegistered").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const spawning = runner.spawn(makeAttempt(), makeOptions(), callbacks)
    await runner.killAll()
    release?.()
    await spawning
    expect(FakeAgentSession.instances).toHaveLength(0)
    expect(callbacks.onComplete).not.toHaveBeenCalled()
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  test("nonzero completion exits trigger failure instead of delivery", async () => {
    const runner = new AgentRunnerService()
    const callbacks = makeCallbacks()
    await runner.spawn(makeAttempt(), makeOptions(), callbacks)
    FakeAgentSession.instances[0]?.emit("complete", {
      type: "complete",
      result: { exitCode: 1, output: "agent failed", durationMs: 1, filesChanged: [] },
    })
    expect(callbacks.onComplete).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 1, recoverable: true }))
    expect(runner.activeCount).toBe(0)
  })

  test("operator cancellation suppresses completion, failure, and late spawn events", async () => {
    const runner = new AgentRunnerService()
    const callbacks = makeCallbacks({ onSpawned: vi.fn() })
    await runner.spawn(makeAttempt(), makeOptions(), callbacks)
    const session = FakeAgentSession.instances[0]
    expect(session).toBeDefined()
    if (!session) return
    const cancel = session.cancel.bind(session)
    session.cancel = async () => {
      await cancel()
      session.emit("complete", {
        type: "complete",
        result: { exitCode: 0, output: "partial", durationMs: 1, filesChanged: [] },
      })
      session.emit("error", { type: "error", error: { code: "CRASH", message: "terminated", recoverable: true } })
      session.emit("spawned", { type: "spawned", pid: 123 })
    }
    await runner.kill("att-1")
    expect(callbacks.onComplete).not.toHaveBeenCalled()
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(callbacks.onSpawned).not.toHaveBeenCalled()
    expect(runner.activeCount).toBe(0)
  })

  test("timeout reports TIMEOUT even when cancel synchronously emits completion", async () => {
    vi.useFakeTimers()
    try {
      const runner = new AgentRunnerService()
      const callbacks = makeCallbacks()
      await runner.spawn(makeAttempt(), makeOptions({ timeout: 1 }), callbacks)
      const session = FakeAgentSession.instances[0]
      expect(session).toBeDefined()
      if (!session) return
      const cancel = session.cancel.bind(session)
      session.cancel = async () => {
        await cancel()
        session.emit("complete", {
          type: "complete",
          result: { exitCode: 0, output: "partial", durationMs: 1, filesChanged: [] },
        })
      }
      await vi.advanceTimersByTimeAsync(1_000)
      expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ code: "TIMEOUT" }))
      expect(callbacks.onComplete).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

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
