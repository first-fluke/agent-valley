import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { AgentRunnerService, resolveInactivityTimeoutSec } from "../sessions/adapters/agent-runner-service"
import { registerSession } from "../sessions/session-factory"
import { FakeAgentSession } from "./characterization/helpers"

vi.mock("../sessions/session-factory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sessions/session-factory")>()
  return { ...actual, registerBuiltinSessions: vi.fn(async () => undefined) }
})

const attempt = {
  id: "att-idle-1",
  issueId: "issue-idle",
  workspacePath: "/tmp/ws",
  retryCount: 0,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  exitCode: null,
  agentOutput: null,
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeAgentSession.resetRegistry()
  registerSession("codex", () => new FakeAgentSession())
})
afterEach(() => {
  vi.useRealTimers()
})

describe("inactivity watchdog", () => {
  test("resolves the window from the request, then the environment, then the default", () => {
    expect(resolveInactivityTimeoutSec(90, {})).toBe(90)
    expect(resolveInactivityTimeoutSec(undefined, { AV_AGENT_INACTIVITY_TIMEOUT_SEC: "600" })).toBe(600)
    expect(resolveInactivityTimeoutSec(undefined, {})).toBe(1_800)
    expect(resolveInactivityTimeoutSec(0, {})).toBe(0)
    expect(resolveInactivityTimeoutSec(undefined, { AV_AGENT_INACTIVITY_TIMEOUT_SEC: "0" })).toBe(0)
  })

  test("terminates a session that emits nothing for the inactivity window", async () => {
    const service = new AgentRunnerService()
    const onError = vi.fn()
    await service.spawn(
      attempt,
      { agentType: "codex", timeout: 3_600, inactivityTimeout: 30, prompt: "review", workspacePath: "/tmp/ws" },
      { onComplete: vi.fn(), onError, onHeartbeat: vi.fn() },
    )
    const session = FakeAgentSession.instances[0]
    if (!session) throw new Error("Expected a fake session")
    await vi.advanceTimersByTimeAsync(29_000)
    expect(onError).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "TIMEOUT", message: "Agent stalled: no activity for 30s", recoverable: true }),
    )
    expect(session.killCalls + session.cancelCalls).toBeGreaterThan(0)
    expect(service.getSession(attempt.id)).toBeUndefined()
  })

  test("any session event restarts the inactivity window", async () => {
    const service = new AgentRunnerService()
    const onError = vi.fn()
    await service.spawn(
      attempt,
      { agentType: "codex", timeout: 3_600, inactivityTimeout: 30, prompt: "work", workspacePath: "/tmp/ws" },
      { onComplete: vi.fn(), onError, onHeartbeat: vi.fn() },
    )
    const session = FakeAgentSession.instances[0]
    if (!session) throw new Error("Expected a fake session")
    await vi.advanceTimersByTimeAsync(25_000)
    session.emit("heartbeat", { type: "heartbeat", timestamp: new Date().toISOString() })
    await vi.advanceTimersByTimeAsync(25_000)
    session.emit("output", { type: "output", chunk: "cargo test running" })
    await vi.advanceTimersByTimeAsync(25_000)
    expect(onError).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  test("a disabled window never fires and completion clears the timer", async () => {
    const service = new AgentRunnerService()
    const onError = vi.fn()
    const onComplete = vi.fn()
    await service.spawn(
      attempt,
      { agentType: "codex", timeout: 3_600, inactivityTimeout: 0, prompt: "work", workspacePath: "/tmp/ws" },
      { onComplete, onError, onHeartbeat: vi.fn() },
    )
    await vi.advanceTimersByTimeAsync(3_599_000)
    expect(onError).not.toHaveBeenCalled()
    const session = FakeAgentSession.instances[0]
    if (!session) throw new Error("Expected a fake session")
    session.emit("complete", {
      type: "complete",
      result: { exitCode: 0, output: "done", durationMs: 1, filesChanged: [] },
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })
})
