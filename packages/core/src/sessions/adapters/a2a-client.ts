import { randomUUID } from "node:crypto"
import { z } from "zod"
import { A2A_PROTOCOL_VERSION, type A2aEndpoint, a2aEndpointSchema } from "./a2a-contracts"

export type A2aMethod = "SendMessage" | "GetTask" | "CancelTask"
export interface A2aClientDependencies {
  fetch?: typeof globalThis.fetch
  env?: Readonly<Record<string, string | undefined>>
}

export class A2aClientError extends Error {
  constructor(
    message: string,
    readonly rejectionConfirmed = false,
  ) {
    super(message)
    this.name = "A2aClientError"
  }
}

const cardSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  version: z.string().min(1),
  supportedInterfaces: z
    .array(
      z.object({
        url: z.string().url(),
        protocolBinding: z.string(),
        protocolVersion: z.string(),
        tenant: z.string().optional(),
      }),
    )
    .min(1)
    .max(20),
  capabilities: z.object({
    extensions: z
      .array(z.object({ uri: z.string().optional(), required: z.boolean().optional() }))
      .max(20)
      .optional(),
  }),
  securitySchemes: z
    .record(z.string(), z.object({ httpAuthSecurityScheme: z.object({ scheme: z.string() }).optional() }))
    .optional(),
  securityRequirements: z
    .array(z.object({ schemes: z.record(z.string(), z.object({ list: z.array(z.string()) })) }))
    .max(20)
    .optional(),
  defaultInputModes: z.array(z.string()),
  defaultOutputModes: z.array(z.string()),
  skills: z.array(z.unknown()),
})

export class A2aClient {
  readonly endpoint: A2aEndpoint
  private readonly url: URL
  private readonly cardUrl: URL
  private readonly fetcher: typeof globalThis.fetch
  private readonly token?: string
  private readonly maximum: number

  constructor(endpoint: A2aEndpoint, dependencies: A2aClientDependencies = {}) {
    const parsed = a2aEndpointSchema.safeParse(endpoint)
    if (!parsed.success)
      throw new A2aClientError(
        "Invalid A2A endpoint configuration. Set its URL, identifier and bounded timing options in the endpoint JSON file.",
        true,
      )
    this.endpoint = parsed.data
    this.url = new URL(endpoint.url)
    this.cardUrl = new URL(endpoint.agentCardUrl ?? new URL("/.well-known/agent-card.json", this.url).href)
    if (this.cardUrl.origin !== this.url.origin)
      throw new A2aClientError(
        "A2A agentCardUrl must use the pinned endpoint origin. Correct the trusted endpoint JSON configuration.",
        true,
      )
    this.fetcher = dependencies.fetch ?? globalThis.fetch
    this.maximum = endpoint.maxResponseBytes ?? 1_048_576
    this.token = endpoint.authTokenEnv ? (dependencies.env ?? process.env)[endpoint.authTokenEnv] : undefined
    if (endpoint.authTokenEnv && (!this.token || /[^!-~]/.test(this.token)))
      throw new A2aClientError(
        `Missing or invalid ${endpoint.authTokenEnv}. Set that environment variable before connecting to the configured A2A endpoint.`,
        true,
      )
  }

  async validateCard(signal?: AbortSignal): Promise<void> {
    const raw = await this.request(this.cardUrl, { method: "GET" }, signal)
    const parsed = cardSchema.safeParse(raw)
    if (!parsed.success)
      throw new A2aClientError("A2A Agent Card is invalid. Configure an endpoint serving the A2A 1.0 Agent Card.", true)
    const card = parsed.data
    const selected = card.supportedInterfaces.find(
      (entry) =>
        entry.protocolBinding === "JSONRPC" &&
        entry.protocolVersion === A2A_PROTOCOL_VERSION &&
        new URL(entry.url).href === this.url.href &&
        (entry.tenant ?? undefined) === this.endpoint.tenant,
    )
    if (!selected)
      throw new A2aClientError(
        "Agent Card does not declare the pinned JSONRPC 1.0 endpoint and tenant. Correct the endpoint JSON configuration before dispatch.",
        true,
      )
    if (card.capabilities.extensions?.some((extension) => extension.required))
      throw new A2aClientError(
        "Agent Card requires an unsupported extension. Use an endpoint with no required protocol extensions.",
        true,
      )
    if (
      !card.defaultInputModes.includes("text/plain") ||
      !card.defaultOutputModes.some((mode) => ["application/json", "text/plain"].includes(mode))
    )
      throw new A2aClientError(
        "A2A endpoint does not support the required text input and JSON/text output modes. Select a compatible endpoint.",
        true,
      )
    const requirements = card.securityRequirements ?? []
    const authorized =
      requirements.length === 0 ||
      requirements.some((requirement) => {
        const schemes = Object.entries(requirement.schemes)
        if (schemes.length === 0) return true
        if (schemes.length !== 1 || !this.token) return false
        const [name, scopes] = schemes[0] ?? []
        return (
          !!name &&
          scopes?.list.length === 0 &&
          card.securitySchemes?.[name]?.httpAuthSecurityScheme?.scheme.toLowerCase() === "bearer"
        )
      })
    if (!authorized)
      throw new A2aClientError(
        "A2A Agent Card authentication is unsupported or missing. Configure its Bearer token environment variable, or select a supported endpoint.",
        true,
      )
  }

  async rpc(method: A2aMethod, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const id = randomUUID()
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: { ...params, ...(this.endpoint.tenant ? { tenant: this.endpoint.tenant } : {}) },
    })
    if (Buffer.byteLength(body) > this.maximum)
      throw new A2aClientError(
        "A2A request exceeds the configured byte limit. Reduce the assignment before dispatch.",
        true,
      )
    const raw = await this.request(this.url, { method: "POST", body }, signal)
    const parsed = z
      .object({
        jsonrpc: z.literal("2.0"),
        id: z.literal(id),
        result: z.unknown().optional(),
        error: z.object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() }).optional(),
      })
      .safeParse(raw)
    if (
      !parsed.success ||
      Number(Object.hasOwn(parsed.data ?? {}, "result")) + Number(Boolean(parsed.data?.error)) !== 1
    )
      throw new A2aClientError(
        "A2A response envelope or request identity is invalid. Reconcile a dispatched execution before retrying.",
      )
    if (parsed.data.error) {
      const code = parsed.data.error.code
      throw new A2aClientError(
        `A2A ${method} was rejected with RPC code ${code}. Inspect the endpoint and reconcile any dispatched execution.`,
        [-32700, -32600, -32601, -32602].includes(code),
      )
    }
    return parsed.data.result
  }

  private async request(url: URL, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.endpoint.requestTimeoutMs ?? 30_000)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response: Response
    try {
      response = await this.fetcher(url, {
        ...init,
        redirect: "error",
        signal: combined,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "A2A-Version": A2A_PROTOCOL_VERSION,
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
      })
    } catch {
      throw new A2aClientError(
        "A2A transport failed or timed out. A submission may already have been accepted; reconcile it before retrying.",
      )
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new A2aClientError(
        `A2A endpoint returned HTTP ${response.status}. Inspect authentication and endpoint availability before retrying.`,
        [400, 401, 403, 405, 415].includes(response.status),
      )
    }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
      await response.body?.cancel().catch(() => {})
      throw new A2aClientError(
        "A2A response must be application/json. Correct the pinned JSONRPC endpoint before retrying.",
      )
    }
    const length = Number(response.headers.get("content-length") ?? 0)
    if (length > this.maximum) {
      await response.body?.cancel().catch(() => {})
      throw new A2aClientError(
        "A2A response exceeds the configured byte limit. Reconcile the execution using bounded endpoint output.",
      )
    }
    const reader = response.body?.getReader()
    if (!reader) throw new A2aClientError("A2A endpoint returned an empty response. Reconcile any submitted execution.")
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > this.maximum) throw new Error("Response limit exceeded")
        chunks.push(value)
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
    } catch {
      await reader.cancel().catch(() => {})
      throw new A2aClientError(
        "A2A response was interrupted, malformed, or oversized. Reconcile the execution before retrying.",
      )
    } finally {
      reader.releaseLock()
    }
  }
}
