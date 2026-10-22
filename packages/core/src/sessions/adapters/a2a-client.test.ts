import { afterEach, describe, expect, it, vi } from "vitest"
import { card, protocolServer, reply } from "../../__tests__/a2a.fixture"
import { A2aClient } from "./a2a-client"
import { type A2aEndpoint, a2aEndpointSchema } from "./a2a-contracts"

const endpoint: A2aEndpoint = { id: "trusted", url: "https://agent.example/rpc" }
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})
function json(value: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json", ...headers } })
}
function fetcher(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (url, init) => handler(new URL(String(url)), init ?? {})) as unknown as typeof fetch
}

describe("A2A trusted transport boundary", () => {
  it.each([
    { url: "http://agent.example/rpc" },
    { url: "https://user:secret@agent.example/rpc" },
    { url: "https://agent.example/rpc?token=secret" },
    { url: "https://agent.example/rpc#fragment" },
    { url: "http://localhost/rpc", allowHttpLoopback: true },
    { agentCardUrl: "https://another.example/card" },
  ])("rejects unsafe endpoint configuration %j before accessing the network", (change) => {
    const network = fetcher(() => {
      throw new Error("Unexpected network access")
    })
    expect(() => new A2aClient({ ...endpoint, ...change }, { fetch: network })).toThrow("Invalid A2A endpoint")
    expect(network).not.toHaveBeenCalled()
  })

  it("uses the shared strict schema and permits only explicitly enabled literal loopback HTTP", () => {
    expect(a2aEndpointSchema.safeParse({ ...endpoint, token: "must not persist" }).success).toBe(false)
    expect(a2aEndpointSchema.safeParse({ ...endpoint, url: "http://127.0.0.1/rpc" }).success).toBe(false)
    expect(a2aEndpointSchema.safeParse({ ...endpoint, url: "http://[::1]/rpc", allowHttpLoopback: true }).success).toBe(
      true,
    )
  })

  it.each([undefined, "", "token with spaces", "token\nvalue"])(
    "requires a valid credential from its configured environment name",
    (value) => {
      expect(
        () => new A2aClient({ ...endpoint, authTokenEnv: "A2A_TEST_TOKEN" }, { env: { A2A_TEST_TOKEN: value } }),
      ).toThrow("A2A_TEST_TOKEN")
    },
  )

  it("pins the card/interface/tenant and sends bearer credentials only to its configured origin", async () => {
    const server = await protocolServer((rpc, response) => reply(response, rpc, { accepted: true }))
    cleanups.push(server.close)
    const configured = { ...server.endpoint, tenant: "team-one", authTokenEnv: "A2A_TEST_TOKEN" }
    server.setCard({
      ...card(configured),
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } } },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    })
    const client = new A2aClient(configured, { env: { A2A_TEST_TOKEN: "fixture-token" } })
    await client.validateCard()
    expect(await client.rpc("GetTask", { id: "task" })).toEqual({ accepted: true })
    expect(
      server.headers.every(
        (headers) => headers.authorization === "Bearer fixture-token" && headers["a2a-version"] === "1.0",
      ),
    ).toBe(true)
    expect(server.calls[0]?.params.tenant).toBe("team-one")
    server.setCard(card({ ...configured, tenant: "different-tenant" }))
    await expect(client.validateCard()).rejects.toThrow("pinned JSONRPC 1.0 endpoint and tenant")
  })

  it.each([
    { securitySchemes: { oauth: {} }, securityRequirements: [{ schemes: { oauth: { list: ["write"] } } }] },
    { defaultInputModes: ["image/png"] },
    { capabilities: { extensions: [{ uri: "https://example.invalid/extension", required: true }] } },
    { supportedInterfaces: [{ url: endpoint.url, protocolBinding: "JSONRPC", protocolVersion: "0.3" }] },
  ])("rejects unsupported Agent Card requirements %j", async (change) => {
    const client = new A2aClient(endpoint, { fetch: fetcher(() => json({ ...card(endpoint), ...change })) })
    await expect(client.validateCard()).rejects.toThrow()
  })

  it("refuses redirects and keeps transport errors free of credentials and remote error content", async () => {
    const secret = "fixture-sensitive-token"
    const network = fetcher((_url, init) => {
      expect(init.redirect).toBe("error")
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${secret}`)
      throw new Error(`Remote error includes ${secret}`)
    })
    const client = new A2aClient(
      { ...endpoint, authTokenEnv: "A2A_TEST_TOKEN" },
      { fetch: network, env: { A2A_TEST_TOKEN: secret } },
    )
    const error = await client.rpc("SendMessage", {}).catch((caught: unknown) => caught)
    expect(String(error)).toContain("transport failed")
    expect(String(error)).not.toContain(secret)
  })

  it.each([
    { jsonrpc: "2.0", id: "wrong", result: {} },
    { jsonrpc: "2.0", id: "wrong", result: {}, error: { code: -32602, message: "untrusted" } },
    { jsonrpc: "2.0", id: "wrong" },
  ])("rejects malformed or mismatched RPC envelopes", async (value) => {
    const client = new A2aClient(endpoint, { fetch: fetcher(() => json(value)) })
    await expect(client.rpc("SendMessage", {})).rejects.toMatchObject({ rejectionConfirmed: false })
  })

  it("classifies explicit RPC rejection without reflecting remote error text", async () => {
    const client = new A2aClient(endpoint, {
      fetch: fetcher((_url, init) => {
        const request = JSON.parse(String(init.body)) as { id: string }
        return json({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "untrusted credential text" } })
      }),
    })
    await expect(client.rpc("SendMessage", {})).rejects.toMatchObject({
      rejectionConfirmed: true,
      message: expect.not.stringContaining("untrusted credential"),
    })
  })

  it("bounds requests before dispatch and responses before parsing", async () => {
    const network = fetcher(() => {
      throw new Error("Unexpected network access")
    })
    const client = new A2aClient({ ...endpoint, maxResponseBytes: 256 }, { fetch: network })
    await expect(client.rpc("SendMessage", { payload: "x".repeat(300) })).rejects.toMatchObject({
      rejectionConfirmed: true,
    })
    expect(network).not.toHaveBeenCalled()
    for (const response of [
      json({ value: "x".repeat(300) }),
      json({}, { "content-length": "999" }),
      new Response("not json", { headers: { "content-type": "application/json" } }),
      new Response("{}", { headers: { "content-type": "text/html" } }),
    ]) {
      const bounded = new A2aClient({ ...endpoint, maxResponseBytes: 256 }, { fetch: fetcher(() => response) })
      await expect(bounded.rpc("GetTask", { id: "task" })).rejects.toMatchObject({ rejectionConfirmed: false })
    }
  })

  it("times out a real stalled HTTP request", async () => {
    const server = await protocolServer(() => {})
    cleanups.push(server.close)
    const client = new A2aClient({ ...server.endpoint, requestTimeoutMs: 20 })
    await expect(client.rpc("GetTask", { id: "task" })).rejects.toThrow("timed out")
    expect(server.calls).toHaveLength(1)
  })

  it("does not follow a real HTTP redirect to another endpoint", async () => {
    const destination = await protocolServer((rpc, response) => reply(response, rpc, {}))
    cleanups.push(destination.close)
    const source = await protocolServer((_rpc, response) => {
      response.writeHead(307, { location: destination.endpoint.url })
      response.end()
    })
    cleanups.push(source.close)
    await expect(new A2aClient(source.endpoint).rpc("SendMessage", {})).rejects.toThrow("transport failed")
    expect(source.calls).toHaveLength(1)
    expect(destination.calls).toHaveLength(0)
  })
})
