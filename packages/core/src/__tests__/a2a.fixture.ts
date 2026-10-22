import { once } from "node:events"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { vi } from "vitest"
import type { RunAttempt } from "../domain/models"
import type { SpawnInput } from "../domain/ports/agent-runner"
import type {
  A2aCheckpoint,
  A2aEndpoint,
  A2aLifecycle,
  A2aSendResponse,
  A2aTask,
} from "../sessions/adapters/a2a-contracts"
import { makeIssue, makeWorkspace } from "./characterization/helpers"

export type RpcRequest = { jsonrpc: string; id: string; method: string; params: Record<string, unknown> }
export const task = (state = "TASK_STATE_WORKING", id = "remote-task"): A2aTask => ({
  id,
  contextId: "remote-context",
  status: { state: state as A2aTask["status"]["state"] },
  artifacts: [{ artifactId: "result", parts: [{ text: "Remote output" }] }],
})
export function input(overrides: Partial<SpawnInput> = {}): SpawnInput {
  const issue = makeIssue({ id: "a2a-issue", identifier: "A2A-1" })
  const workspace = makeWorkspace(issue)
  return {
    issue,
    workspace,
    attemptId: "a2a-attempt",
    agentType: "remote",
    prompt: "Perform the trusted assignment",
    timeoutMs: 5_000,
    attempt: {
      id: "a2a-attempt",
      issueId: issue.id,
      workspacePath: workspace.path,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      agentOutput: null,
    },
    ...overrides,
  }
}
export function memoryLifecycle(request: SpawnInput, initial?: A2aCheckpoint) {
  let saved = initial
  const checkpoints: A2aCheckpoint[] = []
  const complete = vi.fn(
    async (_response: A2aSendResponse, _checkpoint: A2aCheckpoint): Promise<RunAttempt> => ({
      ...(request.attempt as RunAttempt),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      agentOutput: "Accepted by trusted gate",
    }),
  )
  const lifecycle: A2aLifecycle = {
    load: async () => saved,
    save: async (checkpoint) => {
      saved = structuredClone(checkpoint)
      checkpoints.push(saved)
    },
    complete,
  }
  return { lifecycle, checkpoints, complete, saved: () => saved }
}
export function card(endpoint: A2aEndpoint) {
  return {
    name: "Fixture agent",
    description: "Local deterministic A2A protocol fixture",
    version: "fixture-1",
    supportedInterfaces: [
      {
        url: endpoint.url,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
        ...(endpoint.tenant ? { tenant: endpoint.tenant } : {}),
      },
    ],
    capabilities: {},
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["application/json", "text/plain"],
    skills: [],
  }
}
export async function protocolServer(
  handler: (rpc: RpcRequest, response: ServerResponse, request: IncomingMessage) => void | Promise<void>,
) {
  const calls: RpcRequest[] = []
  let agentCard: unknown
  const headers: IncomingMessage["headers"][] = []
  const server = createServer(async (request, response) => {
    try {
      headers.push(request.headers)
      if (request.method === "GET") {
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify(agentCard))
        return
      }
      let body = ""
      for await (const chunk of request) body += String(chunk)
      const rpc = JSON.parse(body) as RpcRequest
      calls.push(rpc)
      response.setHeader("content-type", "application/json")
      await handler(rpc, response, request)
    } catch {
      response.destroy()
    }
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const endpoint: A2aEndpoint = {
    id: "fixture",
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`,
    allowHttpLoopback: true,
    requestTimeoutMs: 250,
    pollIntervalMs: 1,
  }
  agentCard = card(endpoint)
  return {
    endpoint,
    calls,
    headers,
    setCard: (value: unknown) => {
      agentCard = value
    },
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    },
  }
}
export function reply(response: ServerResponse, rpc: RpcRequest, result: unknown): void {
  response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }))
}
