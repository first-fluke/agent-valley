import { PassThrough } from "node:stream"
import { Client, type JSONRPCMessage, ReadBuffer, serializeMessage, type Transport } from "@modelcontextprotocol/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type AvMcpHandle, startAvMcpStdio } from "../mcp-server"
import { missionApiFixture } from "./mcp-fixture"

let handle: AvMcpHandle | undefined
let client: Client | undefined
afterEach(async () => {
  await client?.close()
  await handle?.close()
  vi.restoreAllMocks()
})

describe("AV MCP stdio transport", () => {
  it("serves a real SDK client with only JSON-RPC on stdout and closes the API on EOF", async () => {
    const api = missionApiFixture()
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const wire: string[] = []
    const buffer = new ReadBuffer()
    const transport: Transport = {
      async start() {
        stdout.on("data", (chunk: Buffer) => {
          wire.push(chunk.toString())
          buffer.append(chunk)
          let message: JSONRPCMessage | null = buffer.readMessage()
          while (message) {
            transport.onmessage?.(message)
            message = buffer.readMessage()
          }
        })
      },
      async send(message) {
        stdin.write(serializeMessage(message))
      },
      async close() {
        stdin.end()
        transport.onclose?.()
      },
    }
    handle = await startAvMcpStdio(api, { workspace: process.cwd(), stdin, stdout, signals: false })
    client = new Client({ name: "stdio-test", version: "1" })
    await client.connect(transport)
    const result = await client.callTool({ name: "av_status", arguments: { missionId: "test-mission" } })
    expect(result.structuredContent).toMatchObject({ status: "waiting", evidence: [{ actual: true, passed: true }] })
    const lines = wire.join("").trim().split("\n")
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.map((line) => JSON.parse(line)).every((frame) => frame.jsonrpc === "2.0")).toBe(true)
    await client.close()
    await vi.waitFor(() => expect(api.close).toHaveBeenCalledTimes(1))
    await handle.close()
    expect(api.close).toHaveBeenCalledTimes(1)
    expect(api.cancel).not.toHaveBeenCalled()
  })

  it("closes transport and API on SIGTERM without cancelling durable missions", async () => {
    const api = missionApiFixture()
    const emitter: NodeJS.EventEmitter = process
    const original = emitter.once.bind(emitter)
    let stop: (() => void) | undefined
    vi.spyOn(emitter, "once").mockImplementation((event, listener) => {
      if (event === "SIGTERM") {
        stop = listener
        return emitter
      }
      return original(event, listener)
    })
    handle = await startAvMcpStdio(api, {
      workspace: process.cwd(),
      stdin: new PassThrough(),
      stdout: new PassThrough(),
    })
    if (!stop) throw new Error("Missing MCP signal handler")
    stop()
    await handle.close()
    expect(api.close).toHaveBeenCalledTimes(1)
    expect(api.cancel).not.toHaveBeenCalled()
  })
})
