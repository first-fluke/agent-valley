import { request as httpRequest } from "node:http"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type AvMcpHttpHandle, startAvMcpHttp } from "../mcp-server-http"
import { missionApiFixture } from "./mcp-fixture"

const token = "local-test-token-012345678901234567890123456789"
const env = { AGENT_VALLEY_MCP_TOKEN: token }
let handle: AvMcpHttpHandle | undefined
let client: Client | undefined
afterEach(async () => {
  await client?.close()
  await handle?.close()
  handle = undefined
  client = undefined
})
async function start() {
  const api = missionApiFixture()
  handle = await startAvMcpHttp(api, {
    workspace: process.cwd(),
    host: "127.0.0.1",
    port: 0,
    env,
    signals: false,
    diagnostic: vi.fn(),
  })
  return { api, url: handle.url }
}

describe("AV authenticated Streamable HTTP", () => {
  it("connects an official SDK client and reads actual status and Markdown over HTTP", async () => {
    const { api, url } = await start()
    client = new Client({ name: "http-test", version: "1" })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    )
    expect((await client.listTools()).tools).toHaveLength(6)
    expect(
      (await client.callTool({ name: "av_status", arguments: { missionId: "test-mission" } })).structuredContent,
    ).toMatchObject({ status: "waiting" })
    expect((await client.readResource({ uri: "av://missions/test-mission/report" })).contents[0]).toMatchObject({
      mimeType: "text/markdown",
      text: expect.stringContaining("Actual report"),
    })
    await client.close()
    await handle?.close()
    expect(api.close).toHaveBeenCalledTimes(1)
    expect(api.cancel).not.toHaveBeenCalled()
  })

  it("rejects missing/wrong bearer credentials, hostile origins and DNS rebinding hosts before invoking the service", async () => {
    const { api, url } = await start()
    const request = {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      headers: { "Content-Type": "application/json" },
    }
    expect((await fetch(url, request)).status).toBe(401)
    expect(
      (await fetch(url, { ...request, headers: { ...request.headers, Authorization: "Bearer invalid" } })).status,
    ).toBe(401)
    expect(
      (
        await fetch(url, {
          ...request,
          headers: { ...request.headers, Authorization: `Bearer ${token}`, Origin: "https://attacker.example" },
        })
      ).status,
    ).toBe(403)
    const hostileHostStatus = await new Promise<number | undefined>((resolveResponse, rejectRequest) => {
      const probe = httpRequest(
        url,
        { method: "POST", headers: { ...request.headers, Authorization: `Bearer ${token}`, Host: "attacker.example" } },
        (response) => {
          response.resume()
          response.once("end", () => resolveResponse(response.statusCode))
        },
      )
      probe.once("error", rejectRequest)
      probe.end(request.body)
    })
    expect(hostileHostStatus).toBe(403)
    expect(api.order).not.toHaveBeenCalled()
    expect(api.list).not.toHaveBeenCalled()
  })

  it("permits effect-free browser preflight only for an allowed origin and still authenticates the actual request", async () => {
    const { api, url } = await start()
    const origin = new URL(url).origin
    const response = await fetch(url, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,mcp-param-goal",
      },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin)
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Mcp-Param-Goal")
    expect((await fetch(url, { method: "POST", headers: { Origin: origin } })).status).toBe(401)
    expect((await fetch(url, { method: "OPTIONS", headers: { Origin: "null" } })).status).toBe(403)
    expect(api.list).not.toHaveBeenCalled()
  })

  it("bounds request bodies and accepts only the MCP route", async () => {
    const { api, url } = await start()
    expect((await fetch(url.replace("/mcp", "/shell"), { headers: { Authorization: `Bearer ${token}` } })).status).toBe(
      404,
    )
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: "x".repeat(1_048_577),
        })
      ).status,
    ).toBe(413)
    expect(api.order).not.toHaveBeenCalled()
  })

  it.each([
    { host: "0.0.0.0", env },
    { host: "localhost", env: {} },
    { host: "localhost", env: { AGENT_VALLEY_MCP_TOKEN: "short" } },
    { host: "localhost", env, port: -1 },
    { host: "localhost", env, allowedOrigins: ["https://example.com/path"] },
  ])("rejects invalid HTTP configuration before listening: %j", async (options) => {
    await expect(
      startAvMcpHttp(missionApiFixture(), { workspace: process.cwd(), signals: false, ...options }),
    ).rejects.toThrow()
  })
})
