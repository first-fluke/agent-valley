import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RunAttempt } from "../domain/models"
import { AgentRunError, type AgentRunnerPort, type RunHandle, type SpawnInput } from "../domain/ports/agent-runner"
import { fixture } from "./goal-supervision.fixture"
import { ChiefRuntime } from "./runtime"
import { MissionStore } from "./store"
import type { Mission } from "./types"

let directory: string
let mission: Mission
let store: MissionStore
let runtime: ChiefRuntime | undefined

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "chief-port-"))
  mission = fixture().mission
  mission.workspace.path = directory
  store = new MissionStore(join(directory, "records"))
})
afterEach(async () => {
  await runtime?.close()
  await rm(directory, { recursive: true, force: true })
})

function injectedRunner(start: (input: SpawnInput) => Promise<RunHandle>): AgentRunnerPort {
  return { capabilities: () => [], spawn: vi.fn(start) }
}

function handle(input: SpawnInput, result: Promise<RunAttempt>, overrides: Partial<RunHandle> = {}): RunHandle {
  void result.catch(() => {})
  return {
    attemptId: input.attemptId,
    issueKey: input.issue.identifier,
    result,
    executionCapabilities: { cancellation: "unsupported", forceStop: false, reconnect: true },
    isAlive: () => false,
    cancel: vi.fn(async () => {
      throw new Error("Cancellation unavailable")
    }),
    kill: vi.fn(async () => {
      throw new Error("Force stop unavailable")
    }),
    onEvent: () => () => {},
    send: async () => {},
    ...overrides,
  }
}

function observed(input: SpawnInput, exitCode = 0): RunAttempt {
  if (!input.attempt) throw new Error("Expected caller attempt")
  return {
    ...input.attempt,
    finishedAt: new Date().toISOString(),
    exitCode,
    agentOutput: "Runtime evidence",
    tokenUsage: { input: 10, output: 4, model: "observed-model" },
  }
}

function chief() {
  const persona = mission.personas.find((entry) => entry.id === mission.chiefId)
  if (!persona) throw new Error("Missing Chief fixture")
  return persona
}

describe("Chief execution port", () => {
  it("accepts completed execution without a PID or force-stop capability and retains full evidence", async () => {
    let execution: RunHandle | undefined
    const runner = injectedRunner(async (input) => {
      execution = handle(input, Promise.resolve(observed(input)))
      return execution
    })
    runtime = new ChiefRuntime(store, undefined, undefined, undefined, runner)
    expect(await runtime.ports().runAgent(chief(), "Review the evidence", mission, "review")).toBe("Runtime evidence")
    expect(runner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: chief().agentType,
        model: chief().model,
        timeoutMs: mission.timeoutSec * 1_000,
        env: { AGENT_VALLEY_MANAGED_RUN: "1" },
      }),
    )
    expect(execution?.cancel).not.toHaveBeenCalled()
    expect(execution?.kill).not.toHaveBeenCalled()
    expect((await readdir(join(directory, "records"))).some((name) => name.endsWith(".active"))).toBe(false)
    expect((await store.load(mission.id)).operations?.runs[0]).toMatchObject({
      executionState: "settled",
      executionRecovery: "reconcile",
      inputTokens: 10,
      outputTokens: 4,
      actualModel: "observed-model",
      outcome: "passed",
    })
  })

  it("preserves failed runtime usage in the saved attempt", async () => {
    const runner = injectedRunner(async (input) => {
      const attempt = observed(input, 2)
      return handle(input, Promise.reject(new AgentRunError("Observed failure", attempt)))
    })
    runtime = new ChiefRuntime(store, undefined, undefined, undefined, runner)
    await expect(runtime.ports().runAgent(chief(), "Review", mission, "review")).rejects.toThrow("Observed failure")
    expect((await store.load(mission.id)).operations?.runs[0]).toMatchObject({
      executionState: "settled",
      outcome: "failed",
      inputTokens: 10,
      outputTokens: 4,
    })
  })

  it("persists an uncertain accepted execution before allowing provider retry", async () => {
    const runner = injectedRunner(async (input) =>
      handle(
        input,
        Promise.reject(
          new AgentRunError("Submission response lost: fetch failed", observed(input), { outcomeUnknown: true }),
        ),
      ),
    )
    runtime = new ChiefRuntime(store, undefined, undefined, undefined, runner)
    await expect(runtime.ports().runAgent(chief(), "Review", mission, "review")).rejects.toMatchObject({
      kind: "unknown-effect",
    })
    expect((await store.load(mission.id)).operations?.runs[0]).toMatchObject({
      executionState: "unknown",
      finishedAt: null,
      outcome: "pending",
      inputTokens: 10,
    })
  })

  it("preserves submission uncertainty when a nonlocal runner throws before returning its handle", async () => {
    const runner = injectedRunner(async () => {
      throw new Error("Submission response lost")
    })
    runtime = new ChiefRuntime(store, undefined, undefined, undefined, runner)
    await expect(runtime.ports().runAgent(chief(), "Review", mission, "review")).rejects.toMatchObject({
      kind: "unknown-effect",
    })
    expect((await store.load(mission.id)).operations?.runs[0]).toMatchObject({ executionState: "unknown" })
  })

  it.each(["handle", "attempt", "issue", "workspace", "failure"] as const)(
    "retains uncertainty for a mismatched runtime %s without accepting its usage",
    async (mismatch) => {
      const cancel = vi.fn(async () => {})
      const runner = injectedRunner(async (input) => {
        const result = observed(input)
        if (mismatch === "attempt" || mismatch === "failure") result.id = "another-attempt"
        if (mismatch === "issue") result.issueId = "another-issue"
        if (mismatch === "workspace") result.workspacePath = join(directory, "another-worktree")
        return handle(
          input,
          mismatch === "failure"
            ? Promise.reject(new AgentRunError("Unrelated failure", result))
            : Promise.resolve(result),
          { ...(mismatch === "handle" ? { attemptId: "another-handle" } : {}), cancel },
        )
      })
      runtime = new ChiefRuntime(store, undefined, undefined, undefined, runner)
      await expect(runtime.ports().runAgent(chief(), "Review", mission, "review")).rejects.toMatchObject({
        kind: "unknown-effect",
      })
      expect(cancel).not.toHaveBeenCalled()
      expect((await store.load(mission.id)).operations?.runs[0]).toMatchObject({
        executionState: "unknown",
        inputTokens: null,
        outputTokens: null,
      })
    },
  )

  it.each([null, "invalid-date", "2020-01-01T00:00:00.000Z"])(
    "retains uncertainty for an incomplete terminal timestamp %s",
    async (finishedAt) => {
      const runner = injectedRunner(async (input) => handle(input, Promise.resolve({ ...observed(input), finishedAt })))
      runtime = new ChiefRuntime(store, undefined, undefined, undefined, runner)
      await expect(runtime.ports().runAgent(chief(), "Review", mission, "review")).rejects.toMatchObject({
        kind: "unknown-effect",
      })
      expect((await store.load(mission.id)).operations?.runs[0]).toMatchObject({
        executionState: "unknown",
        inputTokens: null,
      })
    },
  )

  it("treats an explicit nonzero terminal result as a known failure", async () => {
    const runner = injectedRunner(async (input) => handle(input, Promise.resolve(observed(input, 2))))
    runtime = new ChiefRuntime(store, undefined, undefined, undefined, runner)
    await expect(runtime.ports().runAgent(chief(), "Review", mission, "review")).rejects.toBeInstanceOf(AgentRunError)
    expect((await store.load(mission.id)).operations?.runs[0]).toMatchObject({
      executionState: "settled",
      outcome: "failed",
      inputTokens: 10,
    })
  })

  it("does not classify an untyped network result failure as a safely retryable attempt", async () => {
    const runner = injectedRunner(async (input) => handle(input, Promise.reject(new Error("fetch failed"))))
    runtime = new ChiefRuntime(store, undefined, undefined, undefined, runner)
    await expect(runtime.ports().runAgent(chief(), "Review", mission, "review")).rejects.toMatchObject({
      kind: "unknown-effect",
    })
    expect((await store.load(mission.id)).operations?.runs[0]).toMatchObject({
      executionState: "unknown",
      finishedAt: null,
    })
  })

  it("joins every execution during close even when another cancellation is uncertain", async () => {
    let firstInput: SpawnInput | undefined
    let failFirst!: (error: unknown) => void
    let releaseSecond!: () => void
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    const secondCancel = vi.fn()
    const runner = injectedRunner(async (input) => {
      // Prompt preparation can finish in either order; route by the caller's identity.
      if (input.prompt.startsWith("First review")) {
        firstInput = input
        return handle(
          input,
          new Promise((_resolve, reject) => {
            failFirst = reject
          }),
          { isAlive: () => true },
        )
      }
      let rejectResult!: (error: unknown) => void
      let alive = true
      return handle(
        input,
        new Promise((_resolve, reject) => {
          rejectResult = reject
        }),
        {
          isAlive: () => alive,
          executionCapabilities: { cancellation: "confirmed", forceStop: false, reconnect: true },
          cancel: async () => {
            secondCancel()
            await secondGate
            alive = false
            rejectResult(new AgentRunError("Cancelled", observed(input), { code: "CANCELLED" }))
          },
        },
      )
    })
    runtime = new ChiefRuntime(store, undefined, undefined, undefined, runner)
    const first = runtime.ports().runAgent(chief(), "First review", mission, "review")
    const firstRejected = expect(first).rejects.toMatchObject({ kind: "unknown-effect" })
    const second = runtime.ports().runAgent(chief(), "Second review", mission, "review")
    const secondRejected = expect(second).rejects.toThrow("Cancelled")
    await vi.waitFor(() => expect(runner.spawn).toHaveBeenCalledTimes(2))
    let closed = false
    const closing = runtime.close().finally(() => {
      closed = true
    })
    const closeRejected = expect(closing).rejects.toBeInstanceOf(AggregateError)
    await vi.waitFor(() => expect(secondCancel).toHaveBeenCalled())
    expect(closed).toBe(false)
    releaseSecond()
    await closeRejected
    if (!firstInput) throw new Error("Missing first run")
    failFirst(new AgentRunError("Unconfirmed execution", observed(firstInput), { outcomeUnknown: true }))
    await Promise.all([firstRejected, secondRejected])
  })

  it("treats a cancellation request without stop confirmation as an uncertain execution", async () => {
    const controller = new AbortController()
    const cancel = vi.fn(async () => {})
    const runner = injectedRunner(async (input) =>
      handle(input, new Promise(() => {}), {
        executionCapabilities: { cancellation: "request-only", forceStop: false, reconnect: true },
        isAlive: () => true,
        cancel,
      }),
    )
    runtime = new ChiefRuntime(store, controller.signal, undefined, undefined, runner)
    const pending = runtime.ports().runAgent(chief(), "Review", mission, "review")
    const rejected = expect(pending).rejects.toMatchObject({ kind: "unknown-effect" })
    await vi.waitFor(() => expect(runner.spawn).toHaveBeenCalledOnce())
    controller.abort()
    await rejected
    expect(cancel).toHaveBeenCalled()
    expect((await store.load(mission.id)).operations?.runs[0]).toMatchObject({ executionState: "unknown" })
  })
})
