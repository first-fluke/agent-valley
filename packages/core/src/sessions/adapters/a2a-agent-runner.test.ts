import { afterEach, describe, expect, it, vi } from "vitest"
import { card, input, memoryLifecycle, protocolServer, reply, task } from "../../__tests__/a2a.fixture"
import { AgentRunError, InterventionUnsupportedError } from "../../domain/ports/agent-runner"
import { A2aAgentRunnerAdapter } from "./a2a-agent-runner"
import { type A2aCheckpoint, a2aRequestSha256 } from "./a2a-contracts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})
async function fixture(handler: Parameters<typeof protocolServer>[0]) {
  const server = await protocolServer(handler)
  cleanups.push(server.close)
  return server
}

describe("A2A execution backend", () => {
  it("rejects a saved attempt bound to another workspace before any dispatch", async () => {
    const server = await fixture(() => {
      throw new Error("Unexpected dispatch")
    })
    const request = input()
    if (!request.attempt) throw new Error("Fixture attempt missing")
    request.attempt.workspacePath = `${request.workspace.path}-different`
    const state = memoryLifecycle(request)
    await expect(new A2aAgentRunnerAdapter(server.endpoint, () => state.lifecycle).spawn(request)).rejects.toThrow(
      "attempt identity",
    )
    expect(server.calls).toHaveLength(0)
    expect(state.checkpoints).toHaveLength(0)
  })

  it("submits once, persists its task before polling, and accepts only the trusted completion gate", async () => {
    const request = input()
    const state = memoryLifecycle(request)
    const server = await fixture((rpc, response) => {
      if (rpc.method === "SendMessage") {
        expect(state.saved()?.phase).toBe("submitting")
        const message = rpc.params.message as { metadata: unknown; role: string }
        expect(message).toMatchObject({
          role: "ROLE_USER",
          metadata: {
            agentValley: { attemptId: request.attemptId, requestSha256: a2aRequestSha256(request, server.endpoint) },
          },
        })
        reply(response, rpc, { task: task() })
      } else {
        expect(state.saved()).toMatchObject({ phase: "accepted", taskId: "remote-task" })
        reply(response, rpc, task("TASK_STATE_COMPLETED"))
      }
    })
    const handle = await new A2aAgentRunnerAdapter(server.endpoint, () => state.lifecycle).spawn(request)
    expect(await handle.result).toMatchObject({ id: request.attemptId, agentOutput: "Accepted by trusted gate" })
    expect(server.calls.map((call) => call.method)).toEqual(["SendMessage", "GetTask"])
    expect(server.headers.every((headers) => headers["a2a-version"] === "1.0")).toBe(true)
    expect(state.complete).toHaveBeenCalledOnce()
    expect(state.saved()).toMatchObject({ phase: "terminal", state: "TASK_STATE_COMPLETED" })
    expect(handle.isAlive()).toBe(false)
    const events: string[] = []
    handle.onEvent((event) => events.push(event.kind))()
    expect(events).toEqual(["started", "complete"])
  })

  it("does not replay a submission whose response was lost, including after restart", async () => {
    const request = input()
    const state = memoryLifecycle(request)
    const server = await fixture((_rpc, response) => {
      response.destroy()
    })
    const adapter = new A2aAgentRunnerAdapter(server.endpoint, () => state.lifecycle)
    await expect((await adapter.spawn(request)).result).rejects.toMatchObject({ outcomeUnknown: true })
    expect(state.saved()).toMatchObject({ phase: "unknown" })
    await expect((await adapter.spawn(request)).result).rejects.toMatchObject({ outcomeUnknown: true })
    expect(server.calls).toHaveLength(1)
    expect(state.complete).not.toHaveBeenCalled()
  })

  it("reconnects accepted and unknown task records using GetTask without SendMessage", async () => {
    const server = await fixture((rpc, response) => reply(response, rpc, task("TASK_STATE_COMPLETED")))
    const request = input()
    for (const phase of ["accepted", "unknown", "terminal"] as const) {
      const checkpoint: A2aCheckpoint = {
        version: 1,
        endpointId: server.endpoint.id,
        endpointUrl: server.endpoint.url,
        attemptId: request.attemptId,
        messageId: "original-message",
        requestSha256: a2aRequestSha256(request, server.endpoint),
        phase,
        taskId: "remote-task",
        contextId: "remote-context",
      }
      const state = memoryLifecycle(request, checkpoint)
      await (await new A2aAgentRunnerAdapter(server.endpoint, () => state.lifecycle).spawn(request)).result
      expect(state.complete).toHaveBeenCalledOnce()
    }
    expect(server.calls.map((call) => call.method)).toEqual(["GetTask", "GetTask", "GetTask"])
  })

  it("rejects changed checkpoint bindings without any protocol dispatch", async () => {
    const server = await fixture(() => {
      throw new Error("Unexpected request")
    })
    const request = input()
    const state = memoryLifecycle(request, {
      version: 1,
      endpointId: server.endpoint.id,
      endpointUrl: server.endpoint.url,
      attemptId: request.attemptId,
      messageId: "original",
      requestSha256: "a".repeat(64),
      phase: "accepted",
      taskId: "remote-task",
    })
    await expect(
      (await new A2aAgentRunnerAdapter(server.endpoint, () => state.lifecycle).spawn(request)).result,
    ).rejects.toMatchObject({ outcomeUnknown: true })
    expect(server.calls).toHaveLength(0)
    expect(state.complete).not.toHaveBeenCalled()
  })

  it.each(["TASK_STATE_INPUT_REQUIRED", "TASK_STATE_AUTH_REQUIRED", "TASK_STATE_UNSPECIFIED"])(
    "preserves %s tasks for explicit intervention",
    async (status) => {
      const server = await fixture((rpc, response) => reply(response, rpc, { task: task(status) }))
      const request = input()
      const state = memoryLifecycle(request)
      await expect(
        (await new A2aAgentRunnerAdapter(server.endpoint, () => state.lifecycle).spawn(request)).result,
      ).rejects.toMatchObject({ outcomeUnknown: true })
      expect(state.saved()).toMatchObject({ phase: "unknown", taskId: "remote-task", state: status })
      expect(state.complete).not.toHaveBeenCalled()
    },
  )

  it.each(["TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED"])(
    "retains known terminal failure %s without invoking the artifact gate",
    async (status) => {
      const server = await fixture((rpc, response) => reply(response, rpc, { task: task(status) }))
      const request = input()
      const state = memoryLifecycle(request)
      await expect(
        (await new A2aAgentRunnerAdapter(server.endpoint, () => state.lifecycle).spawn(request)).result,
      ).rejects.toMatchObject({ outcomeUnknown: false })
      expect(state.saved()).toMatchObject({ phase: "terminal", state: status })
      expect(state.complete).not.toHaveBeenCalled()
    },
  )

  it("requires the trusted gate for a direct agent message and never replays a taskless terminal checkpoint", async () => {
    const server = await fixture((rpc, response) =>
      reply(response, rpc, {
        message: {
          messageId: "reply",
          contextId: "context",
          role: "ROLE_AGENT",
          parts: [{ text: "Unverified claim" }],
        },
      }),
    )
    const request = input()
    const state = memoryLifecycle(request)
    const adapter = new A2aAgentRunnerAdapter(server.endpoint, () => state.lifecycle)
    expect(await (await adapter.spawn(request)).result).toMatchObject({ agentOutput: "Accepted by trusted gate" })
    expect(state.complete).toHaveBeenCalledOnce()
    await expect((await adapter.spawn(request)).result).rejects.toMatchObject({ outcomeUnknown: true })
    expect(server.calls).toHaveLength(1)
  })

  it("confirms remote cancellation without applying completed artifacts", async () => {
    const server = await fixture((rpc, response) => {
      if (rpc.method === "SendMessage") reply(response, rpc, { task: task() })
      else reply(response, rpc, task(rpc.method === "CancelTask" ? "TASK_STATE_COMPLETED" : "TASK_STATE_WORKING"))
    })
    const request = input()
    const state = memoryLifecycle(request)
    const handle = await new A2aAgentRunnerAdapter(server.endpoint, () => state.lifecycle).spawn(request)
    await vi.waitFor(() => expect(state.saved()?.taskId).toBe("remote-task"))
    await handle.cancel()
    await expect(handle.result).rejects.toMatchObject({ code: "CANCELLED", outcomeUnknown: false })
    expect(state.complete).not.toHaveBeenCalled()
    expect(server.calls.some((call) => call.method === "CancelTask")).toBe(true)
    expect(handle.executionCapabilities).toMatchObject({ cancellation: "confirmed", forceStop: false, reconnect: true })
    await expect(handle.kill()).rejects.toThrow("force stop")
    await expect(handle.send({ kind: "pause" })).rejects.toBeInstanceOf(InterventionUnsupportedError)
  })

  it("reconciles a lost cancellation response through GetTask", async () => {
    let cancelled = false
    const server = await fixture((rpc, response) => {
      if (rpc.method === "SendMessage") reply(response, rpc, { task: task() })
      else if (rpc.method === "CancelTask") {
        cancelled = true
        response.destroy()
      } else reply(response, rpc, task(cancelled ? "TASK_STATE_CANCELED" : "TASK_STATE_WORKING"))
    })
    const request = input()
    const state = memoryLifecycle(request)
    const handle = await new A2aAgentRunnerAdapter(server.endpoint, () => state.lifecycle).spawn(request)
    await vi.waitFor(() => expect(state.saved()?.taskId).toBe("remote-task"))
    await handle.cancel()
    await expect(handle.result).rejects.toBeInstanceOf(AgentRunError)
    expect(state.saved()).toMatchObject({ phase: "terminal", state: "TASK_STATE_CANCELED" })
    expect(server.calls.filter((call) => call.method === "SendMessage")).toHaveLength(1)
  })

  it("does not claim cancellation when a known remote task cannot be inspected", async () => {
    let cancelling = false
    const server = await fixture((rpc, response) => {
      if (rpc.method === "SendMessage") reply(response, rpc, { task: task() })
      else if (rpc.method === "CancelTask" || cancelling) {
        cancelling = true
        response.statusCode = 404
        response.end("{}")
      } else reply(response, rpc, task())
    })
    const request = input()
    const state = memoryLifecycle(request)
    const handle = await new A2aAgentRunnerAdapter(server.endpoint, () => state.lifecycle).spawn(request)
    await vi.waitFor(() => expect(state.saved()?.taskId).toBe("remote-task"))
    await expect(handle.cancel()).rejects.toMatchObject({ outcomeUnknown: true })
    await expect(handle.result).rejects.toMatchObject({ outcomeUnknown: true })
    expect(state.complete).not.toHaveBeenCalled()
  })

  it("refuses required unsupported extensions before submitting work", async () => {
    const server = await fixture(() => {
      throw new Error("Unexpected dispatch")
    })
    server.setCard({
      ...card(server.endpoint),
      capabilities: { extensions: [{ uri: "https://example.invalid/unknown", required: true }] },
    })
    const request = input()
    const state = memoryLifecycle(request)
    await expect(
      (await new A2aAgentRunnerAdapter(server.endpoint, () => state.lifecycle).spawn(request)).result,
    ).rejects.toMatchObject({ outcomeUnknown: false })
    expect(server.calls).toHaveLength(0)
  })

  it("does not submit until the durable checkpoint is saved", async () => {
    const server = await fixture(() => {
      throw new Error("Unexpected dispatch")
    })
    const request = input()
    const state = memoryLifecycle(request)
    state.lifecycle.save = async () => {
      throw new Error("Disk unavailable")
    }
    await expect(
      (await new A2aAgentRunnerAdapter(server.endpoint, () => state.lifecycle).spawn(request)).result,
    ).rejects.toMatchObject({ outcomeUnknown: false })
    expect(server.calls).toHaveLength(0)
    expect(state.complete).not.toHaveBeenCalled()
  })

  it("preserves uncertainty if an accepted task cannot be durably recorded", async () => {
    const server = await fixture((rpc, response) => reply(response, rpc, { task: task("TASK_STATE_COMPLETED") }))
    const request = input()
    const state = memoryLifecycle(request)
    const save = state.lifecycle.save
    state.lifecycle.save = async (checkpoint) => {
      if (checkpoint.taskId) throw new Error("Disk unavailable after SendMessage")
      await save(checkpoint)
    }
    const adapter = new A2aAgentRunnerAdapter(server.endpoint, () => state.lifecycle)
    await expect((await adapter.spawn(request)).result).rejects.toMatchObject({ outcomeUnknown: true })
    expect(state.saved()?.phase).toBe("submitting")
    await expect((await adapter.spawn(request)).result).rejects.toMatchObject({ outcomeUnknown: true })
    expect(server.calls).toHaveLength(1)
    expect(state.complete).not.toHaveBeenCalled()
  })

  it("rejects a different remote task identity before accepting artifacts", async () => {
    const server = await fixture((rpc, response) =>
      reply(
        response,
        rpc,
        rpc.method === "SendMessage" ? { task: task() } : task("TASK_STATE_COMPLETED", "another-task"),
      ),
    )
    const request = input()
    const state = memoryLifecycle(request)
    await expect(
      (await new A2aAgentRunnerAdapter(server.endpoint, () => state.lifecycle).spawn(request)).result,
    ).rejects.toMatchObject({ outcomeUnknown: true })
    expect(state.saved()).toMatchObject({ phase: "unknown", taskId: "remote-task" })
    expect(state.complete).not.toHaveBeenCalled()
  })

  it.each([{ id: "other-attempt" }, { finishedAt: null }, { exitCode: 2 }])(
    "rejects incomplete or mismatched completion evidence %j",
    async (change) => {
      const server = await fixture((rpc, response) => reply(response, rpc, { task: task("TASK_STATE_COMPLETED") }))
      const request = input()
      const state = memoryLifecycle(request)
      if (!request.attempt) throw new Error("Fixture attempt missing")
      state.complete.mockResolvedValue({
        ...request.attempt,
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        ...change,
      })
      await expect(
        (await new A2aAgentRunnerAdapter(server.endpoint, () => state.lifecycle).spawn(request)).result,
      ).rejects.toMatchObject({ outcomeUnknown: true })
    },
  )

  it("does not dispatch an already aborted request", async () => {
    const server = await fixture(() => {
      throw new Error("Unexpected dispatch")
    })
    const controller = new AbortController()
    controller.abort()
    const request = input({ signal: controller.signal })
    const state = memoryLifecycle(request)
    const handle = await new A2aAgentRunnerAdapter(server.endpoint, () => state.lifecycle).spawn(request)
    await handle.cancel()
    await expect(handle.result).rejects.toMatchObject({ code: "CANCELLED", outcomeUnknown: false })
    expect(server.calls).toHaveLength(0)
  })

  it("bounds a stalled GetTask by the execution deadline and confirms remote timeout cancellation", async () => {
    const server = await fixture((rpc, response) => {
      if (rpc.method === "SendMessage") reply(response, rpc, { task: task() })
      else if (rpc.method === "CancelTask") reply(response, rpc, task("TASK_STATE_CANCELED"))
    })
    const request = input({ timeoutMs: 100 })
    const state = memoryLifecycle(request)
    const started = Date.now()
    const handle = await new A2aAgentRunnerAdapter(
      { ...server.endpoint, requestTimeoutMs: 1_000 },
      () => state.lifecycle,
    ).spawn(request)
    await expect(handle.result).rejects.toMatchObject({ code: "TIMEOUT", outcomeUnknown: false })
    expect(Date.now() - started).toBeLessThan(800)
    expect(server.calls.map((call) => call.method)).toEqual(["SendMessage", "GetTask", "CancelTask"])
    expect(state.complete).not.toHaveBeenCalled()
  })

  it("keeps a still-running task uncertain when cancellation never reaches a terminal state", async () => {
    const server = await fixture((rpc, response) =>
      reply(response, rpc, rpc.method === "SendMessage" ? { task: task() } : task()),
    )
    const request = input()
    const state = memoryLifecycle(request)
    const handle = await new A2aAgentRunnerAdapter(
      { ...server.endpoint, requestTimeoutMs: 50 },
      () => state.lifecycle,
    ).spawn(request)
    await vi.waitFor(() => expect(state.saved()?.taskId).toBe("remote-task"))
    await expect(handle.cancel()).rejects.toMatchObject({ outcomeUnknown: true })
    expect(state.saved()).toMatchObject({ phase: "unknown", taskId: "remote-task" })
    expect(state.complete).not.toHaveBeenCalled()
  })

  it("follows an associated direct message through its task before gating completion", async () => {
    const server = await fixture((rpc, response) =>
      reply(
        response,
        rpc,
        rpc.method === "SendMessage"
          ? {
              message: {
                messageId: "reply",
                taskId: "remote-task",
                contextId: "remote-context",
                role: "ROLE_AGENT",
                parts: [{ text: "Task accepted" }],
              },
            }
          : task("TASK_STATE_COMPLETED"),
      ),
    )
    const request = input()
    const state = memoryLifecycle(request)
    await (await new A2aAgentRunnerAdapter(server.endpoint, () => state.lifecycle).spawn(request)).result
    expect(server.calls.map((call) => call.method)).toEqual(["SendMessage", "GetTask"])
    expect(state.complete).toHaveBeenCalledWith(
      { task: task("TASK_STATE_COMPLETED") },
      expect.objectContaining({ phase: "terminal", taskId: "remote-task" }),
      expect.any(AbortSignal),
    )
  })
})
