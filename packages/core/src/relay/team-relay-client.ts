import { normalizeTeamRelayUrl } from "../config/team-schema"
import type { LedgerEvent } from "../domain/ledger"
import {
  type TeamIdentity,
  teamEventsResponseSchema,
  teamIdSchema,
  teamPublishRequestSchema,
  teamPublishResponseSchema,
  teamSessionResponseSchema,
} from "./team-event-codec"
import { TeamRelayError } from "./team-relay-error"

export { TeamRelayError } from "./team-relay-error"
export type TeamRelayFetch = (input: URL, init: RequestInit) => Promise<Response>
const responseError = () =>
  new TeamRelayError(
    "invalid_response",
    "Team relay returned an invalid response. Ask its administrator to check the relay version.",
    502,
  )

/** User-token client. It never receives a Turso database token. */
export class TeamRelayClient {
  readonly relayUrl: string
  readonly teamId: string
  #token: string
  #fetcher: TeamRelayFetch

  constructor(options: { relayUrl: string; token: string; teamId: string; fetcher?: TeamRelayFetch }) {
    if (
      !teamIdSchema.safeParse(options.teamId).success ||
      !z.string().min(1).max(4_096).regex(/^\S+$/).safeParse(options.token).success
    )
      throw new TeamRelayError("invalid_request", "Supply a team UUID and a valid user session token.", 400)
    try {
      this.relayUrl = normalizeTeamRelayUrl(options.relayUrl)
    } catch {
      throw new TeamRelayError(
        "invalid_request",
        "Set team.relay_url to HTTPS or a local HTTP relay without credentials, query or fragment.",
        400,
      )
    }
    this.teamId = options.teamId
    this.#token = options.token
    this.#fetcher = options.fetcher ?? fetch
  }

  private endpoint(path: string): URL {
    return new URL(`${this.relayUrl.replace(/\/$/, "")}${path}`)
  }

  private async request(url: URL, body?: unknown): Promise<unknown> {
    let response: Response
    try {
      response = await this.#fetcher(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${this.#token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      throw new TeamRelayError("team_unavailable", "Team relay is unavailable. Check its URL and connection.", 503)
    }
    if (!response.ok) {
      if (response.status === 401)
        throw new TeamRelayError("session_invalid", "Team session is unavailable or expired. Run av login again.", 401)
      if (response.status === 403)
        throw new TeamRelayError(
          "team_access_denied",
          "Team access was denied. Ask its administrator to check membership and node ownership.",
          403,
        )
      if (response.status === 409)
        throw new TeamRelayError("event_conflict", "This event ID already belongs to different content.", 409)
      throw new TeamRelayError(
        "team_unavailable",
        "Team relay rejected the request. Check its configuration and version.",
        response.status >= 400 && response.status < 500 ? response.status : 503,
      )
    }
    try {
      if (!response.body) throw responseError()
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.byteLength
          if (size > 4_194_304) throw responseError()
          chunks.push(part.value)
        }
      } finally {
        await reader.cancel().catch(() => undefined)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      throw responseError()
    }
  }

  async getSession(): Promise<TeamIdentity> {
    const url = this.endpoint("/api/team/session")
    url.searchParams.set("team_id", this.teamId)
    const parsed = teamSessionResponseSchema.safeParse(await this.request(url))
    if (!parsed.success || parsed.data.identity.teamId !== this.teamId) throw responseError()
    if (parsed.data.identity.expiresAt <= Date.now())
      throw new TeamRelayError("session_invalid", "Team session expired. Run av login again.", 401)
    return parsed.data.identity
  }

  async readEvents(afterSeq: number, limit: number): Promise<LedgerEvent[]> {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
      throw new TeamRelayError("invalid_request", "Use a nonnegative event cursor and a page size from 1 to 1000.", 400)
    const url = this.endpoint("/api/team/relay")
    url.searchParams.set("team_id", this.teamId)
    url.searchParams.set("after", String(afterSeq))
    url.searchParams.set("limit", String(limit))
    const parsed = teamEventsResponseSchema.safeParse(await this.request(url))
    if (!parsed.success || parsed.data.events.length > limit) throw responseError()
    let cursor = afterSeq
    for (const event of parsed.data.events) {
      if (event.seq <= cursor) throw responseError()
      cursor = event.seq
    }
    return parsed.data.events
  }

  async publish(event: unknown, eventId: string): Promise<void> {
    const parsed = teamPublishRequestSchema.safeParse({ teamId: this.teamId, eventId, event })
    if (!parsed.success)
      throw new TeamRelayError("invalid_event", "Supply a valid ledger event and stable event ID.", 400)
    if (!teamPublishResponseSchema.safeParse(await this.request(this.endpoint("/api/team/relay"), parsed.data)).success)
      throw responseError()
  }
}

import { z } from "zod"
