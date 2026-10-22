/**
 * SpawnAgentRunnerAdapter unit tests.
 *
 * Covers the port-level contract extracted from AgentRunnerService (PR4):
 *   - capability table maps known agent types correctly
 *   - spawn() validates attemptId/agentType with actionable errors
 *   - send() dispatches on capability and throws
 *     InterventionUnsupportedError when a command is not in the set
 *   - send({kind:"abort"}) triggers the underlying service.kill()
 *   - handle.cancel()/kill() invoke service.kill and flip isAlive
 *
 * The underlying AgentRunnerService is stubbed via FakeAgentSession
 * registration so nothing spawns a real subprocess.
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 4.4 (PR4).
 */

import { beforeEach, describe, expect, test, vi } from "vitest"
import type { SpawnInput } from "../domain/ports/agent-runner"
import { AgentRunError, InterventionUnsupportedError } from "../domain/ports/agent-runner"
import { CAPABILITY_TABLE, defaultCapabilities, SpawnAgentRunnerAdapter } from "../sessions/adapters/spawn-agent-runner"
import { registerSession } from "../sessions/session-factory"
import { FakeAgentSession, makeIssue, makeWorkspace } from "./characterization/helpers"

// Block SessionRegistry.registerBuiltins from clobbering our fake registrations.
vi.mock("../sessions/session-factory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sessions/session-factory")>()
  return {
    ...actual,
    registerBuiltinSessions: vi.fn(async () => undefined),
  }
})

function buildSpawnInput(overrides: { agentType?: string; attemptId?: string } = {}): SpawnInput {
  const issue = makeIssue({ id: "issue-srv-1", identifier: "PROJ-SRV-1" })
  return {
    issue,
    workspace: makeWorkspace(issue),
    prompt: "do the thing",
    agentType: overrides.agentType ?? "claude",
    timeoutMs: 5_000,
    attemptId: overrides.attemptId ?? "att-srv-1",
  }
}

beforeEach(() => {
  FakeAgentSession.resetRegistry()
  registerSession("claude", () => new FakeAgentSession())
  registerSession("codex", () => new FakeAgentSession())
  registerSession("gemini", () => new FakeAgentSession())
})

describe("SpawnAgentRunnerAdapter — capabilities", () => {
  test("qwen advertises only the implemented single-shot abort capability", () => {
    expect(new SpawnAgentRunnerAdapter().capabilities("qwen")).toEqual(["abort"])
  })
  test("claude advertises append_prompt + abort (stateless) and no pause/resume", () => {
    const adapter = new SpawnAgentRunnerAdapter()
    const caps = adapter.capabilities("claude")
    expect(caps).toEqual(["append_prompt", "abort"])
  })

  test("codex advertises the full intervention set", () => {
    const adapter = new SpawnAgentRunnerAdapter()
    expect(adapter.capabilities("codex")).toEqual(["pause", "resume", "append_prompt", "abort"])
  })

  test("gemini advertises the conservative set", () => {
    const adapter = new SpawnAgentRunnerAdapter()
    expect(adapter.capabilities("gemini")).toEqual(["append_prompt", "abort"])
  })

  test("unknown agent type falls back to append_prompt + abort", () => {
    expect(defaultCapabilities("phantom")).toEqual(["append_prompt", "abort"])
  })

  test("CAPABILITY_TABLE is frozen (append_prompt never accidentally dropped)", () => {
    expect(Object.isFrozen(CAPABILITY_TABLE)).toBe(true)
  })
})

describe("SpawnAgentRunnerAdapter — spawn input validation", () => {
  test("rejects with actionable error when attemptId is empty", async () => {
    const adapter = new SpawnAgentRunnerAdapter()
    const input = buildSpawnInput({ attemptId: "" })
    await expect(adapter.spawn(input)).rejects.toThrow(/attemptId is required/)
  })

  test("rejects with actionable error when agentType is empty", async () => {
    const adapter = new SpawnAgentRunnerAdapter()
    const input = buildSpawnInput({ agentType: "" })
    await expect(adapter.spawn(input)).rejects.toThrow(/agentType is required/)
  })

  test("spawn returns a handle carrying attemptId and issue identifier", async () => {
    const adapter = new SpawnAgentRunnerAdapter()
    const handle = await adapter.spawn(buildSpawnInput({ attemptId: "att-ok" }))
    expect(handle.attemptId).toBe("att-ok")
    expect(handle.issueKey).toBe("PROJ-SRV-1")
    expect(handle.isAlive()).toBe(true)
    await handle.kill()
  })
})

describe("SpawnAgentRunnerAdapter — send dispatch", () => {
  test("rejects unsupported intervention with InterventionUnsupportedError (claude + pause)", async () => {
    const adapter = new SpawnAgentRunnerAdapter()
    const handle = await adapter.spawn(buildSpawnInput({ agentType: "claude", attemptId: "att-pause" }))
    await expect(handle.send({ kind: "pause" })).rejects.toBeInstanceOf(InterventionUnsupportedError)
    await handle.kill()
  })

  test("carries command kind and agentType on the thrown error", async () => {
    const adapter = new SpawnAgentRunnerAdapter()
    const handle = await adapter.spawn(buildSpawnInput({ agentType: "claude", attemptId: "att-resume" }))
    try {
      await handle.send({ kind: "resume" })
      expect.unreachable("expected InterventionUnsupportedError")
    } catch (err) {
      expect(err).toBeInstanceOf(InterventionUnsupportedError)
      if (err instanceof InterventionUnsupportedError) {
        expect(err.command).toBe("resume")
        expect(err.agentType).toBe("claude")
      }
    }
    await handle.kill()
  })

  test("send(append_prompt) on claude (stateless) throws an actionable error at the port layer", async () => {
    // PR4-C wires append_prompt through the InterventionBus' cancel+retry
    // fallback for stateless agents. At the raw port level, claude
    // sessions cannot append without a higher-level coordinator, so the
    // adapter throws a fix-hint error instead of silently dropping.
    const adapter = new SpawnAgentRunnerAdapter()
    const handle = await adapter.spawn(buildSpawnInput({ agentType: "claude", attemptId: "att-ap" }))
    await expect(handle.send({ kind: "append_prompt", text: "hi" })).rejects.toThrow(/stateless/)
    await handle.kill()
  })

  test("send({kind:'abort'}) invokes service.kill and marks handle not alive", async () => {
    const adapter = new SpawnAgentRunnerAdapter()
    const killSpy = vi.spyOn(adapter.service, "kill")
    const handle = await adapter.spawn(buildSpawnInput({ agentType: "claude", attemptId: "att-abort" }))
    await handle.send({ kind: "abort", reason: "user requested" })
    expect(killSpy).toHaveBeenCalledWith("att-abort")
    expect(handle.isAlive()).toBe(false)
  })

  test("send({kind:'pause'}) on codex requires a session.pause() implementation", async () => {
    // The FakeAgentSession used here does not implement pause(), so
    // PR4-C's port-layer check returns an InterventionUnsupportedError
    // (capability advertised but session cannot honor it).
    const adapter = new SpawnAgentRunnerAdapter()
    const handle = await adapter.spawn(buildSpawnInput({ agentType: "codex", attemptId: "att-codex-pause" }))
    await expect(handle.send({ kind: "pause" })).rejects.toBeInstanceOf(InterventionUnsupportedError)
    await handle.kill()
  })
})

describe("SpawnAgentRunnerAdapter — handle lifecycle", () => {
  test("cancel() and kill() join the same completed shutdown", async () => {
    const adapter = new SpawnAgentRunnerAdapter()
    const killSpy = vi.spyOn(adapter.service, "kill")
    const handle = await adapter.spawn(buildSpawnInput({ attemptId: "att-lifecycle" }))

    await handle.cancel()
    expect(killSpy).toHaveBeenCalledTimes(1)
    expect(handle.isAlive()).toBe(false)

    await handle.kill()
    expect(killSpy).toHaveBeenCalledTimes(1)
  })

  test("subscribers receive the started event and the terminal event after cancellation", async () => {
    const adapter = new SpawnAgentRunnerAdapter()
    const handle = await adapter.spawn(buildSpawnInput({ attemptId: "att-sub" }))
    const events: string[] = []
    const unsubscribe = handle.onEvent((event) => events.push(event.kind))
    await vi.waitFor(() => expect(FakeAgentSession.instances).toHaveLength(1))
    await handle.kill()
    unsubscribe()
    expect(events).toEqual(["started", "error"])
  })

  test("retains synchronous completion and measured usage for late subscribers", async () => {
    const session = new FakeAgentSession()
    session.execute = async () => {
      session.emit("complete", {
        type: "complete",
        result: {
          exitCode: 0,
          output: "Verified result",
          durationMs: 12,
          filesChanged: [],
          tokenUsage: { input: 12, output: 4, model: "measured" },
        },
      })
    }
    registerSession("claude", () => session)
    const adapter = new SpawnAgentRunnerAdapter()
    const handle = await adapter.spawn({ ...buildSpawnInput(), model: "selected", env: { FIXTURE: "forwarded" } })
    expect(await handle.result).toMatchObject({
      exitCode: 0,
      agentOutput: "Verified result",
      tokenUsage: { input: 12, output: 4, model: "measured" },
    })
    expect(session.startCalls[0]).toMatchObject({ model: "selected", env: { FIXTURE: "forwarded" } })
    const events: string[] = []
    handle.onEvent((event) => events.push(event.kind))()
    expect(events).toEqual(["started", "complete"])
    expect(handle.isAlive()).toBe(false)
    expect(session.disposeCalls).toBeGreaterThan(0)
  })

  test("retains startup failure and partial usage in a typed result error", async () => {
    const session = new FakeAgentSession()
    session.start = async () => {
      session.emit("error", {
        type: "error",
        error: {
          code: "CRASH",
          message: "Startup failed",
          recoverable: true,
          exitCode: 2,
          tokenUsage: { input: 7, output: 3, model: "observed" },
        },
      })
    }
    registerSession("claude", () => session)
    const handle = await new SpawnAgentRunnerAdapter().spawn(buildSpawnInput())
    await expect(handle.result).rejects.toMatchObject({
      name: "AgentRunError",
      code: "CRASH",
      outcomeUnknown: false,
      attempt: { exitCode: 2, tokenUsage: { input: 7, output: 3, model: "observed" } },
    })
    const events: string[] = []
    handle.onEvent((event) => events.push(event.kind))()
    expect(events).toEqual(["started", "error"])
    expect(handle.isAlive()).toBe(false)
  })

  test("cancellation joins a delayed start before confirming local cleanup", async () => {
    const session = new FakeAgentSession()
    const start = session.start.bind(session)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    session.start = async (config) => {
      await gate
      await start(config)
    }
    registerSession("claude", () => session)
    const finished = vi.fn()
    const adapter = new SpawnAgentRunnerAdapter(undefined, () => ({
      begin: () => {},
      spawned: () => {},
      finish: finished,
    }))
    const handle = await adapter.spawn(buildSpawnInput())
    await vi.waitFor(() => expect(adapter.service.activeCount).toBe(1))
    let stopped = false
    const cancelling = handle.cancel().then(() => {
      stopped = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(finished).not.toHaveBeenCalled()
    release()
    await cancelling
    await expect(handle.result).rejects.toBeInstanceOf(AgentRunError)
    expect(finished).toHaveBeenCalledOnce()
    expect(session.executeCalls).toEqual([])
    expect(session.disposeCalls).toBeGreaterThanOrEqual(2)
  })

  test("cancellation also joins delayed execution preparation and disposes a late process", async () => {
    const session = new FakeAgentSession()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    session.execute = async () => {
      await gate
      await session.start({ type: "claude", timeout: 5, workspacePath: "/tmp" })
    }
    registerSession("claude", () => session)
    const adapter = new SpawnAgentRunnerAdapter()
    const handle = await adapter.spawn(buildSpawnInput())
    await vi.waitFor(() => expect(adapter.service.activeCount).toBe(1))
    let stopped = false
    const cancelling = handle.cancel().then(() => {
      stopped = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(stopped).toBe(false)
    release()
    await cancelling
    expect(session.isAlive()).toBe(false)
    expect(session.disposeCalls).toBeGreaterThanOrEqual(2)
  })

  test("does not stop another attempt while joining a completed run", async () => {
    const adapter = new SpawnAgentRunnerAdapter()
    const first = await adapter.spawn(buildSpawnInput({ attemptId: "first" }))
    const second = await adapter.spawn(buildSpawnInput({ attemptId: "second" }))
    await vi.waitFor(() => expect(adapter.service.activeCount).toBe(2))
    FakeAgentSession.instances[0]?.emit("complete", {
      type: "complete",
      result: { exitCode: 0, output: "done", durationMs: 1, filesChanged: [] },
    })
    await first.result
    expect(second.isAlive()).toBe(true)
    expect(FakeAgentSession.instances[1]?.cancelCalls).toBe(0)
    expect(adapter.service.activeCount).toBe(1)
    await second.cancel()
  })

  test("aborts before registration without starting a session", async () => {
    const handle = await new SpawnAgentRunnerAdapter().spawn({ ...buildSpawnInput(), signal: AbortSignal.abort() })
    await expect(handle.result).rejects.toMatchObject({ code: "CANCELLED" })
    expect(FakeAgentSession.instances).toHaveLength(0)
  })

  test("reconciles a failed terminal-event disposal after execution actually exits", async () => {
    const session = new FakeAgentSession()
    const dispose = session.dispose.bind(session)
    let disposalCalls = 0
    session.dispose = async () => {
      if (++disposalCalls === 1) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" })
      await dispose()
    }
    session.execute = async () => {
      session.emit("complete", {
        type: "complete",
        result: { exitCode: 0, output: "done", durationMs: 1, filesChanged: [] },
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      await session.cancel()
    }
    registerSession("claude", () => session)
    const handle = await new SpawnAgentRunnerAdapter().spawn(buildSpawnInput())
    expect(await handle.result).toMatchObject({ exitCode: 0, agentOutput: "done" })
    expect(disposalCalls).toBe(2)
    expect(session.isAlive()).toBe(false)
  })

  test("failed process shutdown cannot claim confirmed cancellation without lifecycle hooks", async () => {
    const session = new FakeAgentSession()
    session.cancel = async () => {
      throw new Error("Cancel failed")
    }
    session.kill = async () => {
      throw new Error("Kill failed")
    }
    session.dispose = async () => {
      throw new Error("Dispose failed")
    }
    registerSession("claude", () => session)
    const adapter = new SpawnAgentRunnerAdapter()
    const handle = await adapter.spawn(buildSpawnInput())
    await vi.waitFor(() => expect(adapter.service.activeCount).toBe(1))
    await expect(handle.cancel()).rejects.toMatchObject({ outcomeUnknown: true })
    await expect(handle.result).rejects.toMatchObject({ outcomeUnknown: true })
    expect(session.isAlive()).toBe(true)
  })

  test("unconfirmed local cleanup rejects cancellation and marks the outcome uncertain", async () => {
    const adapter = new SpawnAgentRunnerAdapter(undefined, () => ({
      begin: () => {},
      spawned: () => {},
      finish: () => {
        throw new Error("Process group remains active")
      },
    }))
    const handle = await adapter.spawn(buildSpawnInput())
    await vi.waitFor(() => expect(adapter.service.activeCount).toBe(1))
    await expect(handle.cancel()).rejects.toMatchObject({ outcomeUnknown: true })
    await expect(handle.result).rejects.toMatchObject({ outcomeUnknown: true })
  })
})
