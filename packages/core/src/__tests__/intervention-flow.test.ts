/**
 * Intervention flow integration test — exercises the end-to-end path
 *   Dashboard → InterventionBus → AgentRunnerService → FakeAgentSession
 * through the real SpawnAgentRunnerAdapter + AgentRunnerService.
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 3.1 (C), § 5.7.
 */

import { beforeEach, describe, expect, test, vi } from "vitest"
import { AgentRunnerService } from "../orchestrator/agent-runner"
import { InterventionBus } from "../orchestrator/intervention-bus"
import { SpawnAgentRunnerAdapter } from "../sessions/adapters/spawn-agent-runner"
import { registerSession } from "../sessions/session-factory"
import { FakeAgentSession } from "./characterization/helpers"

// Block the built-in session registration from replacing our fake factories.
vi.mock("../sessions/session-factory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sessions/session-factory")>()
  return {
    ...actual,
    registerBuiltinSessions: vi.fn(async () => undefined),
  }
})

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

beforeEach(() => {
  FakeAgentSession.resetRegistry()
  // Register pause/resume/sendUserMessage capabilities for the fake
  // codex session so the bus has a native path to exercise.
  registerSession("codex", () => {
    const s = new FakeAgentSession()
    ;(s as unknown as { pause: () => Promise<void> }).pause = vi.fn(async () => undefined)
    ;(s as unknown as { resume: () => Promise<void> }).resume = vi.fn(async () => undefined)
    ;(s as unknown as { sendUserMessage: (t: string) => Promise<void> }).sendUserMessage = vi.fn(async () => undefined)
    return s
  })
  registerSession("claude", () => new FakeAgentSession())
})

describe("Intervention flow — codex native path", () => {
  test("pause + resume + append_prompt + abort reach the live fake session", async () => {
    const service = new AgentRunnerService()
    const adapter = new SpawnAgentRunnerAdapter(service)
    const bus = new InterventionBus({ runner: service, port: adapter, logger: makeLogger() })

    await service.ensureRegistered()
    const attemptId = "att-codex-flow-1"
    await service.spawn(
      {
        id: attemptId,
        issueId: "issue-1",
        workspacePath: "/tmp/ws",
        retryCount: 0,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        agentOutput: null,
      },
      {
        agentType: "codex",
        timeout: 60,
        prompt: "do it",
        workspacePath: "/tmp/ws",
      },
      {
        onComplete: () => undefined,
        onError: () => undefined,
        onHeartbeat: () => undefined,
      },
    )

    bus.registerAttempt({ attemptId, issueKey: "PROJ-1", agentType: "codex" })

    const session = service.getSession(attemptId) as unknown as {
      pause: ReturnType<typeof vi.fn>
      resume: ReturnType<typeof vi.fn>
      sendUserMessage: ReturnType<typeof vi.fn>
    }

    const r1 = await bus.send(attemptId, { kind: "pause" })
    expect(r1.ok).toBe(true)
    expect(session.pause).toHaveBeenCalledTimes(1)

    const r2 = await bus.send(attemptId, { kind: "resume" })
    expect(r2.ok).toBe(true)
    expect(session.resume).toHaveBeenCalledTimes(1)

    const r3 = await bus.send(attemptId, { kind: "append_prompt", text: "also update README" })
    expect(r3.ok).toBe(true)
    expect(session.sendUserMessage).toHaveBeenCalledWith("also update README")

    const killSpy = vi.spyOn(service, "kill")
    const r4 = await bus.send(attemptId, { kind: "abort", reason: "op" })
    expect(r4.ok).toBe(true)
    expect(killSpy).toHaveBeenCalledWith(attemptId)
  })
})

describe("Intervention flow — claude stateless fallback", () => {
  test("append_prompt on claude triggers cancel + requestRetry", async () => {
    const service = new AgentRunnerService()
    const adapter = new SpawnAgentRunnerAdapter(service)
    const bus = new InterventionBus({ runner: service, port: adapter, logger: makeLogger() })

    await service.ensureRegistered()
    const attemptId = "att-claude-flow-1"
    await service.spawn(
      {
        id: attemptId,
        issueId: "issue-2",
        workspacePath: "/tmp/ws-2",
        retryCount: 0,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        agentOutput: null,
      },
      {
        agentType: "claude",
        timeout: 60,
        prompt: "do it",
        workspacePath: "/tmp/ws-2",
      },
      {
        onComplete: () => undefined,
        onError: () => undefined,
        onHeartbeat: () => undefined,
      },
    )

    const requestRetry = vi.fn(async () => undefined)
    bus.registerAttempt({
      attemptId,
      issueKey: "PROJ-2",
      agentType: "claude",
      requestRetry,
    })

    const result = await bus.send(attemptId, { kind: "append_prompt", text: "add tests" })
    expect(result.ok).toBe(true)
    expect(requestRetry).toHaveBeenCalledWith("add tests")
    // The fake claude session's cancel was invoked too.
    const fake = FakeAgentSession.instances.at(-1)!
    expect(fake.cancelCalls).toBeGreaterThanOrEqual(1)
  })
})
