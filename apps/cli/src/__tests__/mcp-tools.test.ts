import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import type { McpServer } from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createAvMcpServer } from "../mcp-tools"
import { missionApiFixture } from "./mcp-fixture"

vi.mock("@agent-valley/core/version", () => ({ AV_VERSION: "9.2.1-rc.4" }))

let workspace: string
let client: Client
let server: McpServer
let api: ReturnType<typeof missionApiFixture>
beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), "av-mcp-tools-")))
  api = missionApiFixture()
})
afterEach(async () => {
  await client?.close()
  await server?.close()
  await rm(workspace, { recursive: true, force: true })
})
async function connect(env: NodeJS.ProcessEnv = {}) {
  server = createAvMcpServer(api, { workspace, env })
  client = new Client({ name: "av-test-client", version: "1" })
  const [left, right] = InMemoryTransport.createLinkedPair()
  await server.connect(right)
  await client.connect(left)
}

describe("AV MCP mission tools", () => {
  it("exposes continuous operation tools with async identity and managed recursion guards", async () => {
    const order = vi.fn().mockResolvedValue({ operationId: "continuous-one", status: "starting", accepted: true })
    const operationResume = vi.fn().mockResolvedValue({ operationId: "continuous-one", status: "running" })
    Object.assign(api, {
      order,
      operationResume,
      operations: vi.fn().mockResolvedValue({ operations: [] }),
      operationStatus: vi.fn().mockResolvedValue({ operationId: "continuous-one", status: "waiting" }),
      operationReport: vi.fn().mockResolvedValue({ markdown: "Easy explanation and actual cycle IDs" }),
      operationCancel: vi.fn().mockResolvedValue({ cancelRequested: true }),
    })
    await connect()
    expect((await client.listTools()).tools).toHaveLength(11)
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("av_operate")
    const input = { goal: "Improve service continuously", cycles: 2, requestId: "operation-one" }
    expect((await client.callTool({ name: "av_order", arguments: input })).structuredContent).toMatchObject({
      operationId: "continuous-one",
      accepted: true,
    })
    expect(order).toHaveBeenCalledWith({ ...input, workspace })
    expect((await client.callTool({ name: "av_order", arguments: { ...input, cycles: 0 } })).isError).toBe(true)
    await client.close()
    await server.close()
    await connect({ AGENT_VALLEY_MANAGED_RUN: "1" })
    expect((await client.callTool({ name: "av_order", arguments: input })).isError).toBe(true)
    expect(
      (await client.callTool({ name: "av_operation_resume", arguments: { operationId: "continuous-one" } })).isError,
    ).toBe(true)
    expect(order).toHaveBeenCalledTimes(1)
    expect(operationResume).not.toHaveBeenCalled()
    expect((await client.callTool({ name: "av_operations", arguments: {} })).isError).not.toBe(true)
  })
  it("advertises the installed release version in the protocol handshake", async () => {
    await connect()
    expect(client.getServerVersion()).toEqual({ name: "agent-valley", version: "9.2.1-rc.4" })
  })
  it("advertises exactly eleven lifecycle tools with one order entry and truthful read/write annotations", async () => {
    await connect()
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "av_cancel",
      "av_missions",
      "av_operation_cancel",
      "av_operation_report",
      "av_operation_resume",
      "av_operation_status",
      "av_operations",
      "av_order",
      "av_report",
      "av_resume",
      "av_status",
    ])
    expect(tools.find((tool) => tool.name === "av_order")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    })
    expect(tools.find((tool) => tool.name === "av_report")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    })
  })
  it("returns the asynchronous identity and passes explicit budgets and deduplication identity to the service", async () => {
    await connect()
    const arguments_ = {
      goal: "  Improve onboarding  ",
      requestId: "chat-turn-1",
      parallel: 2,
      runs: 20,
      duration: 60,
      cost: 3,
      verify: "bun test",
    }
    const result = await client.callTool({ name: "av_order", arguments: arguments_ })
    expect(result.structuredContent).toEqual({ operationId: "test-operation", status: "queued" })
    expect(api.order).toHaveBeenCalledWith({ ...arguments_, goal: "Improve onboarding", workspace })
  })
  it("uses once:true for a single mission while preserving the same public entry", async () => {
    await connect()
    const input = { goal: "Fix one bug", once: true, requestId: "once-mode" }
    expect((await client.callTool({ name: "av_order", arguments: input })).structuredContent).toEqual({
      missionId: "test-mission",
      status: "queued",
    })
    expect(api.order).toHaveBeenCalledWith({ ...input, workspace })
  })
  it.each([
    { goal: " " },
    { goal: "Goal", parallel: 9 },
    { goal: "Goal", runs: 0 },
    { goal: "Goal", duration: -1 },
    { goal: "Goal", cost: -2 },
    { goal: "Goal", command: "arbitrary shell" },
    { goal: "Goal", cycles: 0 },
    { goal: "Goal", interval: 0 },
    { goal: "Goal", once: true, cycles: 1 },
    { goal: "Goal", once: true, interval: 30 },
  ])("rejects invalid order input before any mission is started: %j", async (input) => {
    await connect()
    const result = await client.callTool({ name: "av_order", arguments: input })
    expect(result.isError).toBe(true)
    expect(api.order).not.toHaveBeenCalled()
  })
  it("rejects a workspace escape and traversal identities without calling the service", async () => {
    await connect()
    expect((await client.callTool({ name: "av_order", arguments: { goal: "Goal", workspace: ".." } })).isError).toBe(
      true,
    )
    expect((await client.callTool({ name: "av_status", arguments: { missionId: "../other" } })).isError).toBe(true)
    expect(api.order).not.toHaveBeenCalled()
    expect(api.status).not.toHaveBeenCalled()
  })
  it("returns actual status evidence, Markdown and a readable report resource", async () => {
    await connect()
    expect(
      (await client.callTool({ name: "av_status", arguments: { missionId: "test-mission" } })).structuredContent,
    ).toMatchObject({ status: "waiting", evidence: [{ actual: true, passed: true }] })
    expect(
      (await client.callTool({ name: "av_report", arguments: { missionId: "test-mission" } })).structuredContent,
    ).toMatchObject({ uri: "av://missions/test-mission/report", markdown: expect.stringContaining("Actual report") })
    const { contents } = await client.readResource({ uri: "av://missions/test-mission/report" })
    expect(contents[0]).toMatchObject({
      uri: "av://missions/test-mission/report",
      mimeType: "text/markdown",
      text: expect.stringContaining("measured evidence is pending"),
    })
    expect((await client.listResourceTemplates()).resourceTemplates[0]?.uriTemplate).toBe(
      "av://missions/{missionId}/report",
    )
  })
  it("restricts resume to the original mission contract and forwards cancellation", async () => {
    await connect()
    expect(
      (await client.callTool({ name: "av_resume", arguments: { missionId: "test-mission", goal: "different goal" } }))
        .isError,
    ).toBe(true)
    expect(api.resume).not.toHaveBeenCalled()
    await client.callTool({
      name: "av_resume",
      arguments: { missionId: "test-mission", retry: true, duration: 120, requestId: "resume-1" },
    })
    expect(api.resume).toHaveBeenCalledWith({
      missionId: "test-mission",
      retry: true,
      duration: 120,
      requestId: "resume-1",
    })
    await client.callTool({ name: "av_cancel", arguments: { missionId: "test-mission" } })
    expect(api.cancel).toHaveBeenCalledWith("test-mission")
  })
  it("blocks recursive mission creation and resume for managed Actors while keeping inspection available", async () => {
    await connect({ AGENT_VALLEY_MANAGED_RUN: "1" })
    expect((await client.callTool({ name: "av_order", arguments: { goal: "Nested goal" } })).isError).toBe(true)
    expect((await client.callTool({ name: "av_resume", arguments: { missionId: "test-mission" } })).isError).toBe(true)
    expect(api.order).not.toHaveBeenCalled()
    expect(api.resume).not.toHaveBeenCalled()
    const listed = await client.callTool({ name: "av_missions", arguments: {} })
    expect(listed.structuredContent).toMatchObject({
      executionContext: { managed: true, delegationAllowed: false },
    })
    expect(api.list).toHaveBeenCalledTimes(1)
  })
  it("establishes the server delegation context for a web client without a local environment tool", async () => {
    await connect()
    const result = await client.callTool({ name: "av_missions", arguments: {} })
    expect(result.structuredContent).toMatchObject({
      executionContext: { managed: false, delegationAllowed: true },
    })
    expect(api.order).not.toHaveBeenCalled()
  })
  it("reports an unavailable actual report as a tool error rather than fabricating success", async () => {
    await connect()
    api.report.mockRejectedValue(new Error("No report checkpoint yet; inspect av_status."))
    const result = await client.callTool({ name: "av_report", arguments: { missionId: "test-mission" } })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: "text", text: "No report checkpoint yet; inspect av_status." }])
  })
})
