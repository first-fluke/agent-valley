import { afterEach, describe, expect, it, vi } from "vitest"
import { input, memoryLifecycle, protocolServer, reply, task } from "../../__tests__/a2a.fixture"
import { AgentRunError } from "../../domain/ports/agent-runner"
import { A2aAgentRunnerAdapter } from "./a2a-agent-runner"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})
async function fixture(handler: Parameters<typeof protocolServer>[0]) {
  const server = await protocolServer(handler)
  cleanups.push(server.close)
  return server
}
function latch() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release: () => release() }
}

describe("A2A cancellation at durable dispatch boundaries", () => {
  it("does not dispatch when cancellation arrives while persisting the submission barrier", async () => {
    const controller = new AbortController()
    const request = input({ signal: controller.signal })
    const state = memoryLifecycle(request)
    const save = state.lifecycle.save
    state.lifecycle.save = async (checkpoint) => {
      await save(checkpoint)
      if (checkpoint.phase === "submitting") controller.abort()
    }
    const server = await fixture((rpc, response) =>
      reply(response, rpc, rpc.method === "SendMessage" ? { task: task() } : task("TASK_STATE_CANCELED")),
    )
    const handle = await new A2aAgentRunnerAdapter(server.endpoint, () => state.lifecycle).spawn(request)
    await expect(handle.result).rejects.toMatchObject({ code: "CANCELLED", outcomeUnknown: false })
    expect(server.calls).toHaveLength(0)
    expect(state.saved()?.phase).toBe("prepared")
    expect(state.complete).not.toHaveBeenCalled()
  })

  it("does not dispatch after its deadline expires while persisting the submission barrier", async () => {
    const request = input()
    const state = memoryLifecycle(request)
    const now = Date.now()
    const clock = vi.spyOn(Date, "now").mockReturnValue(now)
    const save = state.lifecycle.save
    state.lifecycle.save = async (checkpoint) => {
      await save(checkpoint)
      if (checkpoint.phase === "submitting") clock.mockReturnValue(now + 10_000)
    }
    const server = await fixture((rpc, response) => reply(response, rpc, { task: task() }))
    const handle = await new A2aAgentRunnerAdapter(server.endpoint, () => state.lifecycle).spawn(request)
    await expect(handle.result).rejects.toMatchObject({ code: "TIMEOUT", outcomeUnknown: false })
    expect(server.calls).toHaveLength(0)
    expect(state.saved()?.phase).toBe("prepared")
    expect(state.complete).not.toHaveBeenCalled()
  })

  it("saves an acknowledged message's task ID before cancelling an in-flight submission", async () => {
    const controller = new AbortController()
    const request = input({ signal: controller.signal })
    const state = memoryLifecycle(request)
    const server = await fixture((rpc, response) => {
      if (rpc.method === "SendMessage") {
        controller.abort()
        reply(response, rpc, {
          message: {
            messageId: "accepted",
            role: "ROLE_AGENT",
            taskId: "remote-task",
            contextId: "remote-context",
            parts: [{ text: "Task accepted" }],
          },
        })
      } else {
        expect(state.saved()).toMatchObject({ phase: "accepted", taskId: "remote-task", contextId: "remote-context" })
        reply(response, rpc, task("TASK_STATE_CANCELED"))
      }
    })
    const handle = await new A2aAgentRunnerAdapter(server.endpoint, () => state.lifecycle).spawn(request)
    await expect(handle.result).rejects.toMatchObject({ code: "CANCELLED", outcomeUnknown: false })
    expect(server.calls.map((rpc) => rpc.method)).toEqual(["SendMessage", "CancelTask"])
    expect(state.saved()).toMatchObject({ phase: "terminal", taskId: "remote-task", state: "TASK_STATE_CANCELED" })
    expect(state.complete).not.toHaveBeenCalled()
  })

  it("aborts and joins an in-progress completion gate when the public handle is cancelled", async () => {
    const request = input()
    const state = memoryLifecycle(request)
    const server = await fixture((rpc, response) => reply(response, rpc, { task: task("TASK_STATE_COMPLETED") }))
    const entered = latch()
    const released = latch()
    let applied = false
    const complete = state.lifecycle.complete
    state.lifecycle.complete = async (response, checkpoint, signal) => {
      entered.release()
      await released.promise
      signal?.throwIfAborted()
      applied = true
      return complete(response, checkpoint, signal)
    }
    const handle = await new A2aAgentRunnerAdapter(server.endpoint, () => state.lifecycle).spawn(request)
    await entered.promise
    const cancellation = handle.cancel()
    released.release()
    await cancellation
    await expect(handle.result).rejects.toMatchObject({ code: "CANCELLED", outcomeUnknown: false })
    expect(applied).toBe(false)
    expect(handle.isAlive()).toBe(false)
    expect(server.calls.map((rpc) => rpc.method)).toEqual(["SendMessage"])
  })

  it("preserves unconfirmed local cleanup when cancellation interrupts a terminal task's gate", async () => {
    const request = input()
    const state = memoryLifecycle(request)
    const server = await fixture((rpc, response) => reply(response, rpc, { task: task("TASK_STATE_COMPLETED") }))
    const entered = latch()
    const released = latch()
    if (!request.attempt) throw new Error("Fixture attempt missing")
    const failure = new AgentRunError("Verifier cleanup is unconfirmed", request.attempt, { outcomeUnknown: true })
    state.lifecycle.complete = async () => {
      entered.release()
      await released.promise
      throw failure
    }
    const handle = await new A2aAgentRunnerAdapter(server.endpoint, () => state.lifecycle).spawn(request)
    await entered.promise
    const cancellation = handle.cancel()
    released.release()
    await expect(cancellation).rejects.toBe(failure)
    await expect(handle.result).rejects.toBe(failure)
    expect(state.saved()).toMatchObject({ phase: "unknown", taskId: "remote-task" })
  })
})
