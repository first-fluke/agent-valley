import { createHash } from "node:crypto"
import { createServer, request as httpRequest, type Server } from "node:http"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type AvMcpOAuthOptions, createMcpOAuth, type McpOAuthFetch, resolveMcpOAuthOptions } from "../mcp-oauth"
import { type AvMcpHttpHandle, startAvMcpHttp } from "../mcp-server-http"
import { missionApiFixture } from "./mcp-fixture"

const config: AvMcpOAuthOptions = {
  publicUrl: "https://av.example/mcp",
  issuer: "https://identity.example/tenant",
  audience: "https://av.example/mcp",
  scopes: ["av:access"],
  allowedSubjects: ["owner-123"],
}
const localBearer = "local-test-token-012345678901234567890123456789"
let idpServer: Server | undefined
let gateway: AvMcpHttpHandle | undefined
let client: Client | undefined

afterEach(async () => {
  await client?.close()
  await gateway?.close()
  if (idpServer) {
    const closing = new Promise<void>((resolve, reject) =>
      idpServer?.close((error) => (error ? reject(error) : resolve())),
    )
    idpServer.closeAllConnections()
    await closing
  }
  client = undefined
  gateway = undefined
  idpServer = undefined
  vi.unstubAllGlobals()
})

/** HTTPS discovery/JWKS URLs use a temporary local IdP adapter; no real account or IdP is contacted. */
async function fakeIdp(overrides: Record<string, unknown> = {}, oidcOnly = false) {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true })
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "ES256", use: "sig" }
  const metadata = {
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}/authorize`,
    token_endpoint: `${config.issuer}/token`,
    jwks_uri: `${config.issuer}/jwks`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    ...overrides,
  }
  const requests: string[] = []
  const mint = (claims: JWTPayload = {}, signingKey = privateKey) =>
    new SignJWT({
      iss: config.issuer,
      aud: config.audience,
      sub: "owner-123",
      scope: "av:access",
      iat: Math.floor(Date.now() / 1_000),
      exp: Math.floor(Date.now() / 1_000) + 600,
      ...claims,
    })
      .setProtectedHeader({ alg: "ES256", kid: "test-key" })
      .sign(signingKey)
  let authorizationCode: { challenge: string; redirect: string; resource: string; scope: string } | undefined
  idpServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", config.issuer)
    requests.push(url.pathname)
    if (
      url.pathname ===
      (oidcOnly ? "/tenant/.well-known/openid-configuration" : "/.well-known/oauth-authorization-server/tenant")
    ) {
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end(JSON.stringify(metadata))
    } else if (url.pathname === "/tenant/jwks") {
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ keys: [jwk] }))
    } else if (url.pathname === "/tenant/authorize") {
      if (
        url.searchParams.get("client_id") !== "test-client" ||
        url.searchParams.get("response_type") !== "code" ||
        url.searchParams.get("resource") !== config.publicUrl ||
        url.searchParams.get("code_challenge_method") !== "S256"
      ) {
        response.writeHead(400)
        response.end()
        return
      }
      authorizationCode = {
        challenge: url.searchParams.get("code_challenge") ?? "",
        redirect: url.searchParams.get("redirect_uri") ?? "",
        resource: url.searchParams.get("resource") ?? "",
        scope: url.searchParams.get("scope") ?? "",
      }
      const callback = new URL(authorizationCode.redirect)
      callback.searchParams.set("code", "test-authorization-code")
      callback.searchParams.set("state", url.searchParams.get("state") ?? "")
      response.writeHead(302, { Location: callback.href })
      response.end()
    } else if (url.pathname === "/tenant/token") {
      let body = ""
      request.on("data", (chunk) => {
        body += chunk.toString()
      })
      request.on("end", () => {
        const form = new URLSearchParams(body)
        const code = authorizationCode
        const challenge = createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url")
        if (
          !code ||
          form.get("grant_type") !== "authorization_code" ||
          form.get("client_id") !== "test-client" ||
          form.get("code") !== "test-authorization-code" ||
          form.get("redirect_uri") !== code.redirect ||
          form.get("resource") !== code.resource ||
          challenge !== code.challenge
        ) {
          response.writeHead(400, { "Content-Type": "application/json" })
          response.end(JSON.stringify({ error: "invalid_grant" }))
          return
        }
        authorizationCode = undefined
        void mint({ aud: code.resource, scope: code.scope }).then((accessToken) => {
          response.writeHead(200, { "Content-Type": "application/json" })
          response.end(JSON.stringify({ access_token: accessToken, token_type: "Bearer", expires_in: 600 }))
        })
      })
    } else {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise<void>((resolve, reject) => {
    idpServer?.once("error", reject)
    idpServer?.listen(0, "127.0.0.1", resolve)
  })
  const address = idpServer.address()
  if (!address || typeof address === "string") throw new Error("Fake IdP did not start.")
  const actualFetch = globalThis.fetch.bind(globalThis)
  const adapter: McpOAuthFetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (url.origin === "https://identity.example")
      return actualFetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init)
    return actualFetch(input, init)
  }
  vi.stubGlobal("fetch", adapter)
  return { mint, metadata, requests, adapter }
}

async function startGateway() {
  const api = missionApiFixture()
  gateway = await startAvMcpHttp(api, {
    workspace: process.cwd(),
    host: "127.0.0.1",
    port: 0,
    oauth: config,
    env: { AGENT_VALLEY_MCP_TOKEN: localBearer },
    signals: false,
    diagnostic: vi.fn(),
    allowedOrigins: ["https://client.example"],
  })
  return { api, localUrl: gateway.localUrl }
}

function callStatus(url: string, token?: string, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "av_status", arguments: { missionId: "test-mission" } },
    }),
  })
}

describe("MCP OAuth configuration", () => {
  it("retains local bearer mode only when OAuth configuration is absent", () => {
    expect(resolveMcpOAuthOptions({}, {})).toBeUndefined()
    expect(() => resolveMcpOAuthOptions({ publicUrl: config.publicUrl }, {})).toThrow("AGENT_VALLEY_MCP_OAUTH_ISSUER")
    expect(() => resolveMcpOAuthOptions({ oauthSubject: ["owner-123"] }, {})).toThrow("AGENT_VALLEY_MCP_PUBLIC_URL")
    expect(() => resolveMcpOAuthOptions({ publicUrl: config.publicUrl, oauthIssuer: config.issuer }, {})).toThrow(
      "--oauth-scope",
    )
    expect(() =>
      resolveMcpOAuthOptions(
        { publicUrl: config.publicUrl, oauthIssuer: config.issuer, oauthScope: config.scopes },
        {},
      ),
    ).toThrow("--oauth-subject")
  })

  it("resolves env settings, defaults the audience to the resource, and preserves exact comma-separated subjects", () => {
    expect(
      resolveMcpOAuthOptions(
        {},
        {
          AGENT_VALLEY_MCP_PUBLIC_URL: config.publicUrl,
          AGENT_VALLEY_MCP_OAUTH_ISSUER: config.issuer,
          AGENT_VALLEY_MCP_OAUTH_SCOPES: "av:access av:access,av:write",
          AGENT_VALLEY_MCP_OAUTH_SUBJECTS: "owner-123, another subject",
        },
      ),
    ).toEqual({ ...config, scopes: ["av:access", "av:write"], allowedSubjects: ["owner-123", "another subject"] })
  })

  it.each([
    { publicUrl: "http://av.example/mcp" },
    { publicUrl: "https://av.example/other" },
    { publicUrl: "https://user:password@av.example/mcp" },
    { publicUrl: "https://av.example/mcp?token=secret" },
    { publicUrl: "https://av.example/mcp#fragment" },
    { issuer: "http://identity.example" },
    { audience: "https://other-resource.example/mcp" },
    { scopes: [] },
    { scopes: ['scope"injection'] },
    { scopes: ["offline_access"] },
    { allowedSubjects: [] },
    { allowedSubjects: ["owner\n123"] },
  ])("rejects unsafe or incomplete direct gateway options: %j", async (overrides) => {
    await expect(createMcpOAuth({ ...config, ...overrides })).rejects.toThrow()
  })
})

describe("external IdP discovery and JWT authorization", () => {
  it("discovers OIDC metadata for a path issuer after missing RFC 8414 metadata", async () => {
    const idp = await fakeIdp({}, true)
    const oauth = await createMcpOAuth(config)
    expect(idp.requests).toEqual([
      "/.well-known/oauth-authorization-server/tenant",
      "/.well-known/openid-configuration/tenant",
      "/tenant/.well-known/openid-configuration",
    ])
    expect(await oauth.authorize(`Bearer ${await idp.mint()}`)).toEqual({ authorized: true, subject: "owner-123" })
    expect(await oauth.authorize(`Bearer ${await idp.mint({ scope: undefined, scp: "av:access" })}`)).toEqual({
      authorized: true,
      subject: "owner-123",
    })
  })

  it.each([
    { issuer: "https://other-idp.example" },
    { authorization_endpoint: "http://identity.example/authorize" },
    { token_endpoint: "https://user:secret@identity.example/token" },
    { jwks_uri: "http://identity.example/jwks" },
    { response_types_supported: ["token"] },
    { grant_types_supported: ["client_credentials"] },
    { code_challenge_methods_supported: ["plain"] },
    { code_challenge_methods_supported: undefined },
  ])("fails startup for incompatible or untrusted IdP metadata: %j", async (overrides) => {
    await fakeIdp(overrides)
    await expect(createMcpOAuth(config)).rejects.toThrow()
  })

  it("rejects unavailable, redirected, malformed and oversized discovery without accepting fallback metadata", async () => {
    await expect(createMcpOAuth(config, async () => new Response(null, { status: 404 }))).rejects.toThrow(
      "no discovery document",
    )
    await expect(createMcpOAuth(config, async () => new Response(null, { status: 302 }))).rejects.toThrow(
      "successful discovery",
    )
    await expect(createMcpOAuth(config, async () => new Response("invalid-json"))).rejects.toThrow("valid JSON")
    await expect(createMcpOAuth(config, async () => new Response("x".repeat(65_537)))).rejects.toThrow("64 KiB")
    await expect(
      createMcpOAuth(config, async () => {
        throw new Error("network failure")
      }),
    ).rejects.toThrow("HTTPS connectivity")
  })

  it.each([
    { claims: { iss: "https://attacker.example" }, status: 401 },
    { claims: { iss: undefined }, status: 401 },
    { claims: { aud: "https://another-api.example" }, status: 401 },
    { claims: { aud: undefined }, status: 401 },
    { claims: { exp: 1 }, status: 401 },
    { claims: { exp: undefined }, status: 401 },
    { claims: { nbf: 9_999_999_999 }, status: 401 },
    { claims: { sub: undefined }, status: 401 },
    { claims: { sub: "another-user" }, status: 403 },
    { claims: { scope: "av:read" }, status: 403 },
    { claims: { scope: undefined }, status: 403 },
  ])("rejects unauthorized access before service calls: %j", async ({ claims, status }) => {
    const idp = await fakeIdp()
    const { api, localUrl } = await startGateway()
    const response = await callStatus(localUrl, await idp.mint(claims))
    expect(response.status).toBe(status)
    expect(response.headers.get("WWW-Authenticate")).toContain("resource_metadata=")
    expect(api.status).not.toHaveBeenCalled()
    expect(api.order).not.toHaveBeenCalled()
  })

  it("rejects a forged signature and local static bearer credentials in OAuth mode", async () => {
    const idp = await fakeIdp()
    const { privateKey } = await generateKeyPair("ES256")
    const { api, localUrl } = await startGateway()
    expect((await callStatus(localUrl, await idp.mint({}, privateKey))).status).toBe(401)
    expect((await callStatus(localUrl, localBearer)).status).toBe(401)
    expect((await callStatus(localUrl)).status).toBe(401)
    expect(api.status).not.toHaveBeenCalled()
  })
})

describe("public OAuth MCP gateway", () => {
  it("publishes unauthenticated resource discovery and a canonical HTTPS challenge", async () => {
    const idp = await fakeIdp()
    const { api, localUrl } = await startGateway()
    expect(gateway?.url).toBe(config.publicUrl)
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const url = new URL(path, localUrl)
      const response = await fetch(url)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        resource: config.publicUrl,
        authorization_servers: [config.issuer],
        scopes_supported: config.scopes,
        bearer_methods_supported: ["header"],
      })
      expect((await fetch(url, { method: "HEAD" })).status).toBe(200)
      expect((await fetch(url, { method: "POST" })).status).toBe(405)
    }
    const unauthorized = await callStatus(localUrl)
    expect(unauthorized.headers.get("WWW-Authenticate")).toContain(
      'resource_metadata="https://av.example/.well-known/oauth-protected-resource/mcp"',
    )
    expect(unauthorized.headers.get("WWW-Authenticate")).toContain('scope="av:access"')
    expect(
      (await fetch(idp.metadata.token_endpoint.replace("/token", "/.well-known/openid-configuration"))).status,
    ).toBe(404)
    expect(api.status).not.toHaveBeenCalled()
  })

  it("accepts the configured proxy Host, rejects spoofed forwarding and hostile Origin, and exposes challenges to allowed clients", async () => {
    const idp = await fakeIdp()
    const { api, localUrl } = await startGateway()
    const token = await idp.mint()
    const spoof = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        localUrl,
        {
          method: "POST",
          headers: {
            Host: "attacker.example",
            Authorization: `Bearer ${token}`,
            "X-Forwarded-Host": "av.example",
            Forwarded: "host=av.example;proto=https",
          },
        },
        (response) => {
          response.resume()
          response.once("end", () => resolve(response.statusCode))
        },
      )
      request.once("error", reject)
      request.end()
    })
    expect(spoof).toBe(403)
    expect((await callStatus(localUrl, token, { Origin: "https://attacker.example" })).status).toBe(403)
    const preflight = await fetch(localUrl, { method: "OPTIONS", headers: { Origin: "https://client.example" } })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("Access-Control-Expose-Headers")).toContain("WWW-Authenticate")
    const allowed = await callStatus(localUrl, undefined, { Origin: "https://client.example" })
    expect(allowed.status).toBe(401)
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://client.example")
    const publicHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        new URL("/.well-known/oauth-protected-resource", localUrl),
        {
          headers: { Host: "av.example", Origin: "https://av.example", "X-Forwarded-Host": "attacker.example" },
        },
        (response) => {
          response.resume()
          response.once("end", () => resolve(response.statusCode))
        },
      )
      request.once("error", reject)
      request.end()
    })
    expect(publicHost).toBe(200)
    expect(api.status).not.toHaveBeenCalled()
  })

  it("exchanges a PKCE authorization code with the fake IdP and uses its JWT through an official MCP client", async () => {
    const idp = await fakeIdp()
    const { api, localUrl } = await startGateway()
    const verifier = "test-pkce-verifier-0123456789012345678901234567890123456789"
    const authorizeUrl = new URL(idp.metadata.authorization_endpoint)
    authorizeUrl.search = new URLSearchParams({
      client_id: "test-client",
      response_type: "code",
      redirect_uri: "https://client.example/callback",
      resource: config.publicUrl,
      scope: "av:access",
      state: "test-state",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }).toString()
    const authorization = await fetch(authorizeUrl, { redirect: "manual" })
    const callback = new URL(authorization.headers.get("Location") ?? "")
    expect(callback.searchParams.get("state")).toBe("test-state")
    const tokenForm = {
      client_id: "test-client",
      grant_type: "authorization_code",
      code: callback.searchParams.get("code") ?? "",
      redirect_uri: "https://client.example/callback",
      resource: config.publicUrl,
      code_verifier: verifier,
    }
    expect(
      (
        await fetch(idp.metadata.token_endpoint, {
          method: "POST",
          body: new URLSearchParams({ ...tokenForm, code_verifier: "wrong" }),
        })
      ).status,
    ).toBe(400)
    const exchange = await fetch(idp.metadata.token_endpoint, { method: "POST", body: new URLSearchParams(tokenForm) })
    expect(exchange.status).toBe(200)
    const token = (await exchange.json()) as { access_token: string }
    expect(
      (await fetch(idp.metadata.token_endpoint, { method: "POST", body: new URLSearchParams(tokenForm) })).status,
    ).toBe(400)
    client = new Client({ name: "oauth-integration-test", version: "1" })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(localUrl), {
        requestInit: { headers: { Authorization: `Bearer ${token.access_token}` } },
      }),
    )
    expect((await client.listTools()).tools).toHaveLength(6)
    expect(
      (await client.callTool({ name: "av_status", arguments: { missionId: "test-mission" } })).structuredContent,
    ).toMatchObject({ status: "waiting" })
    expect((await client.readResource({ uri: "av://missions/test-mission/report" })).contents[0]).toMatchObject({
      text: expect.stringContaining("Actual report"),
    })
    expect(api.status).toHaveBeenCalledTimes(1)
    expect(api.report).toHaveBeenCalledTimes(1)
    expect(idp.requests).toContain("/tenant/jwks")
    expect(api.order).not.toHaveBeenCalled()
  })
})
