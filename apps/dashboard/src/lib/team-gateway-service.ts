import {
  teamEventsResponseSchema,
  teamPublishRequestSchema,
  teamSessionResponseSchema,
} from "@agent-valley/core/relay/team-event-codec"
import { TeamRelayError } from "@agent-valley/core/relay/team-relay-error"
import { TursoTeamStore } from "@agent-valley/core/relay/turso-team-store"
import { z } from "zod"
import { sameOrigin } from "./dashboard-auth"
import { toOrchestratorConfig } from "./env"
import { resolveProjectRoot } from "./project-root"

const MAX_BODY_BYTES = 64_000
const teamQuerySchema = z.strictObject({ team_id: teamPublishRequestSchema.shape.teamId })
const eventsQuerySchema = teamQuerySchema.extend({
  after: z
    .string()
    .regex(/^\d+$/)
    .default("0")
    .transform(Number)
    .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)),
  limit: z.string().regex(/^\d+$/).default("1000").transform(Number).pipe(z.number().int().min(1).max(1000)),
})
const storeConfigSchema = z.object({
  tursoUrl: z.string().min(1),
  tursoAuthTokenEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .default("TURSO_AUTH_TOKEN"),
})

interface GatewayConfig {
  tursoUrl?: string
  tursoAuthTokenEnv?: string
}

type GatewayStore = Pick<TursoTeamStore, "authenticate" | "readEvents" | "publish" | "close">

export interface TeamGatewayDeps {
  loadConfig?: () => GatewayConfig | Promise<GatewayConfig>
  createStore?: (config: { url: string; authToken?: string }) => GatewayStore
  env?: Readonly<Record<string, string | undefined>>
}

class RequestFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

const relayErrors: Record<string, { status: number; message: string }> = {
  session_invalid: {
    status: 401,
    message: "Team session is invalid or expired. Run av login with a valid team token.",
  },
  node_access_denied: {
    status: 403,
    message: "This token cannot publish for that node. Use the node identity assigned to your team membership.",
  },
  event_conflict: {
    status: 409,
    message: "This event ID already records different data. Retry the original event or use a new event ID.",
  },
  invalid_event: { status: 400, message: "The event is invalid. Send an event matching the team relay schema." },
  invalid_request: { status: 400, message: "The team request is invalid. Check its team ID and relay parameters." },
  team_storage_error: {
    status: 503,
    message: "Team storage is unavailable. Check the server database configuration and retry.",
  },
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } })
}

function errorResponse(error: unknown): Response {
  if (error instanceof RequestFailure) return json({ code: error.code, message: error.message }, error.status)
  const known =
    error instanceof TeamRelayError && Object.hasOwn(relayErrors, error.code) ? relayErrors[error.code] : undefined
  if (known) return json({ code: (error as TeamRelayError).code, message: known.message }, known.status)
  return json({ code: "team_storage_error", message: relayErrors.team_storage_error?.message }, 503)
}

function bearer(request: Request): string {
  const match = /^Bearer ([^\s,]+)$/i.exec(request.headers.get("authorization") ?? "")
  if (!match?.[1] || match[1].length > 4096)
    throw new RequestFailure("session_invalid", relayErrors.session_invalid?.message ?? "Use a valid team token.", 401)
  return match[1]
}

function query(request: Request): Record<string, string> {
  const values = [...new URL(request.url).searchParams]
  if (new Set(values.map(([key]) => key)).size !== values.length)
    throw new RequestFailure("invalid_request", "Do not repeat team relay query parameters.", 400)
  return Object.fromEntries(values)
}

async function body(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    throw new RequestFailure("invalid_request", "Send the relay event as application/json.", 415)
  const declared = request.headers.get("content-length")
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES))
    throw new RequestFailure("request_too_large", "Relay event bodies must be at most 64,000 bytes.", 413)
  const reader = request.body?.getReader()
  if (!reader) throw new RequestFailure("invalid_request", "Send a JSON team relay event body.", 400)
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel()
        throw new RequestFailure("request_too_large", "Relay event bodies must be at most 64,000 bytes.", 413)
      }
      chunks.push(chunk.value)
    }
    const buffer = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) {
      buffer.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer))
  } catch (error) {
    if (error instanceof RequestFailure) throw error
    throw new RequestFailure("invalid_request", "Send one valid UTF-8 JSON team relay event.", 400)
  } finally {
    reader.releaseLock()
  }
}

async function withStore(deps: TeamGatewayDeps, work: (store: GatewayStore) => Promise<Response>): Promise<Response> {
  const config = await (
    deps.loadConfig ?? (async () => toOrchestratorConfig(await resolveProjectRoot(process.cwd())))
  )()
  const parsed = storeConfigSchema.safeParse(config)
  if (!parsed.success)
    throw new RequestFailure(
      "team_config_incomplete",
      "Set team.turso_url and team.turso_auth_token_env in av.yaml or settings.yaml on this relay server.",
      503,
    )
  let url: URL
  try {
    url = new URL(parsed.data.tursoUrl)
    if (
      !["file:", "libsql:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid database URL")
  } catch {
    throw new RequestFailure(
      "team_config_invalid",
      "Set team.turso_url to a file, libsql or HTTPS database URL without embedded credentials, query or fragment on this relay server.",
      503,
    )
  }
  const authToken = (deps.env ?? process.env)[parsed.data.tursoAuthTokenEnv]?.trim()
  if (url.protocol !== "file:" && !authToken)
    throw new RequestFailure(
      "team_config_incomplete",
      `Set ${parsed.data.tursoAuthTokenEnv} on this relay server before connecting its configured Turso database.`,
      503,
    )
  const store = (deps.createStore ?? ((options) => new TursoTeamStore(options)))({
    url: parsed.data.tursoUrl,
    ...(authToken ? { authToken } : {}),
  })
  try {
    return await work(store)
  } finally {
    await store.close()
  }
}

export async function readTeamSession(request: Request, deps: TeamGatewayDeps = {}): Promise<Response> {
  try {
    const token = bearer(request)
    const input = teamQuerySchema.safeParse(query(request))
    if (!input.success)
      throw new RequestFailure("invalid_request", "Set only the required team_id query parameter.", 400)
    return await withStore(deps, async (store) =>
      json(teamSessionResponseSchema.parse({ identity: await store.authenticate(token, input.data.team_id) })),
    )
  } catch (error) {
    return errorResponse(error)
  }
}

export async function readTeamEvents(request: Request, deps: TeamGatewayDeps = {}): Promise<Response> {
  try {
    const token = bearer(request)
    const input = eventsQuerySchema.safeParse(query(request))
    if (!input.success)
      throw new RequestFailure(
        "invalid_request",
        "Set team_id, a nonnegative integer after cursor, and a limit from 1 to 1000.",
        400,
      )
    return await withStore(deps, async (store) =>
      json(
        teamEventsResponseSchema.parse({
          events: await store.readEvents(token, input.data.team_id, input.data.after, input.data.limit),
        }),
      ),
    )
  } catch (error) {
    return errorResponse(error)
  }
}

export async function publishTeamEvent(request: Request, deps: TeamGatewayDeps = {}): Promise<Response> {
  try {
    const token = bearer(request)
    if (request.headers.has("origin") && !sameOrigin(request))
      throw new RequestFailure("origin_denied", "Browser relay mutations must use the dashboard's own Origin.", 403)
    const input = teamPublishRequestSchema.safeParse(await body(request))
    if (!input.success)
      throw new RequestFailure(
        "invalid_request",
        "Send only teamId, eventId and a valid event. User identity comes from the team token.",
        400,
      )
    return await withStore(deps, async (store) => {
      await store.publish(token, input.data.teamId, input.data.eventId, input.data.event)
      return json({ ok: true })
    })
  } catch (error) {
    return errorResponse(error)
  }
}
