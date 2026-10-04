import { timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { localhostHostValidation, toNodeHandler } from "@modelcontextprotocol/node"
import { createMcpHandler } from "@modelcontextprotocol/server"
import type { AvMcpOptions, MissionApiPort } from "./mcp-contract"
import { type AvMcpOAuthOptions, createMcpOAuth } from "./mcp-oauth"
import type { AvMcpHandle } from "./mcp-server"
import { createAvMcpServer } from "./mcp-tools"

export interface AvMcpHttpOptions extends AvMcpOptions {
  host?: string
  port?: number
  tokenEnv?: string
  allowedOrigins?: string[]
  oauth?: AvMcpOAuthOptions
  signals?: boolean
}
export interface AvMcpHttpHandle extends AvMcpHandle {
  url: string
  localUrl: string
}
const loopback = new Set(["localhost", "127.0.0.1", "::1"])

function reject(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "Content-Type": "application/json" })
  response.end(JSON.stringify({ error: message }))
}

function authenticated(request: IncomingMessage, token: string): boolean {
  const authorization = request.headers.authorization
  if (!authorization?.startsWith("Bearer ")) return false
  const supplied = Buffer.from(authorization.slice(7))
  const expected = Buffer.from(token)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

/** Loopback listener; public OAuth clients connect through a configured HTTPS reverse proxy. */
export async function startAvMcpHttp(api: MissionApiPort, options: AvMcpHttpOptions): Promise<AvMcpHttpHandle> {
  const host = options.host ?? "localhost"
  const port = options.port ?? 3_331
  if (!loopback.has(host))
    throw new Error(
      "AV MCP HTTP must bind localhost, 127.0.0.1 or ::1. Use an authenticated HTTPS reverse proxy for remote clients.",
    )
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error("MCP --port must be an integer from 0 through 65535.")
  const tokenEnv = options.tokenEnv ?? "AGENT_VALLEY_MCP_TOKEN"
  if (!/^[A-Z][A-Z0-9_]*$/.test(tokenEnv)) throw new Error("Set --token-env to an environment variable name.")
  const token = (options.env ?? process.env)[tokenEnv]
  if (!options.oauth && (!token || token.length < 32 || /\s/.test(token)))
    throw new Error(`Set ${tokenEnv} to a bearer token of at least 32 characters before starting HTTP MCP.`)
  const origins = new Set(
    (options.allowedOrigins ?? []).map((origin) => {
      const url = new URL(origin)
      if (!["https:", "http:"].includes(url.protocol) || url.origin !== origin || url.username || url.password)
        throw new Error("MCP allowed origins must be exact HTTP(S) origins without a path or credentials.")
      return url.origin
    }),
  )
  const oauth = options.oauth ? await createMcpOAuth(options.oauth) : undefined
  const publicHost = oauth ? new URL(oauth.publicUrl).host.toLowerCase() : undefined
  if (oauth) origins.add(new URL(oauth.publicUrl).origin)
  const diagnostic = options.diagnostic ?? ((message: string) => process.stderr.write(`${message}\n`))
  const handler = createMcpHandler(() => createAvMcpServer(api, options), {
    legacy: "stateless",
    responseMode: "auto",
    maxRequestBodySize: 1_048_576,
    onerror: (error) => diagnostic(error.message),
  })
  const handle = toNodeHandler(handler, {
    maxRequestBodySize: 1_048_576,
    onerror: (error) => diagnostic(error.message),
  })
  const validateHost = localhostHostValidation()
  let addressPort = port
  const server = createServer((request, response) => {
    // Only this explicit Host is accepted for the public proxy. Forwarded headers never establish trust.
    if ((!publicHost || request.headers.host?.toLowerCase() !== publicHost) && !validateHost(request, response)) return
    const origin = request.headers.origin
    if (
      origin &&
      !origins.has(origin) &&
      !["localhost", "127.0.0.1", "[::1]"].some((name) => origin === `http://${name}:${addressPort}`)
    ) {
      reject(response, 403, "Origin is not allowed. Configure an exact allowed origin for the client.")
      return
    }
    if (origin) {
      response.setHeader("Access-Control-Allow-Origin", origin)
      response.setHeader("Vary", "Origin")
      response.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Param-MissionId, Mcp-Param-RequestId, Mcp-Param-Goal, Mcp-Param-Workspace, Mcp-Param-Verify, Mcp-Param-Parallel, Mcp-Param-Runs, Mcp-Param-Duration, Mcp-Param-Cost, Mcp-Param-Retry, Mcp-Param-Rounds",
      )
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
      response.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, MCP-Session-Id, MCP-Protocol-Version")
    }
    const discovery =
      oauth &&
      ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"].includes(request.url ?? "")
    if (request.url !== "/mcp" && !discovery) {
      reject(response, 404, "Use the /mcp endpoint or its OAuth protected resource metadata.")
      return
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    if (discovery) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("Allow", "GET, HEAD, OPTIONS")
        reject(response, 405, "OAuth protected resource metadata accepts GET or HEAD.")
        return
      }
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
      response.end(request.method === "HEAD" ? undefined : JSON.stringify(oauth?.resourceMetadata))
      return
    }
    const authorizedRequest = async (): Promise<void> => {
      if (oauth) {
        const authorization = await oauth.authorize(request.headers.authorization)
        if (!authorization.authorized) {
          response.setHeader(
            "WWW-Authenticate",
            oauth.challenge(authorization.error === "access_denied" ? undefined : authorization.error),
          )
          reject(
            response,
            authorization.status,
            authorization.error === "access_denied"
              ? "The authenticated user is not authorized to operate this AV workspace."
              : authorization.error === "insufficient_scope"
                ? "The access token lacks the AV scopes required for this workspace."
                : "A valid OAuth access token is required.",
          )
          return
        }
      } else if (!authenticated(request, token ?? "")) {
        response.setHeader("WWW-Authenticate", "Bearer")
        reject(response, 401, "A valid bearer token is required.")
        return
      }
      await handle(request, response)
    }
    void authorizedRequest().catch((error: unknown) => {
      diagnostic(error instanceof Error ? error.message : "MCP request failed.")
      if (!response.headersSent) reject(response, 500, "MCP request failed.")
      else response.end()
    })
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen)
      server.listen(port, host, () => {
        server.removeListener("error", rejectListen)
        resolveListen()
      })
    })
  } catch (error) {
    await handler.close()
    throw error
  }
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("MCP HTTP listen address is unavailable.")
  addressPort = address.port
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= Promise.resolve().then(async () => {
      process.removeListener("SIGINT", stop)
      process.removeListener("SIGTERM", stop)
      try {
        await handler.close()
        const closed = new Promise<void>((resolveClose, rejectClose) =>
          server.close((error) => (error ? rejectClose(error) : resolveClose())),
        )
        server.closeAllConnections()
        await closed
      } finally {
        await api.close()
      }
    })
    return closing
  }
  const stop = () => {
    void close().catch((error: unknown) => diagnostic(error instanceof Error ? error.message : "MCP shutdown failed."))
  }
  if (options.signals !== false) {
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  }
  const localUrl = `http://${host === "::1" ? "[::1]" : host}:${addressPort}/mcp`
  return { url: oauth?.publicUrl ?? localUrl, localUrl, close }
}
