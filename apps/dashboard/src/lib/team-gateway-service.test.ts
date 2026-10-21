import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TeamRelayError } from "@agent-valley/core/relay/team-relay-error"
import { TursoTeamStore } from "@agent-valley/core/relay/turso-team-store"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { publishTeamEvent, readTeamEvents, readTeamSession, type TeamGatewayDeps } from "./team-gateway-service"

const teamId = "c7765322-08c7-4f5d-9e4b-d3ccba94d50b"
const otherTeamId = "9ef049fa-5dac-43fa-9d3a-f834ca32f29d"
const userId = "2179cd67-714f-474b-b018-9411dcc34353"
const otherUserId = "39340e1c-e8cd-4fda-a898-69d2d71a53c5"
const base = "https://relay.example.test"
let root: string
let url: string
let admin: TursoTeamStore
let token: string
let otherToken: string
let deps: TeamGatewayDeps

function event(nodeId = `${userId}:desktop`) {
  return {
    nodeId,
    type: "node.join",
    clientTimestamp: "2026-10-21T00:00:00Z",
    payload: { defaultAgentType: "codex", maxParallel: 2, displayName: "Alice" },
  }
}

function request(path: string, authorization: string | undefined = token): Request {
  return new Request(`${base}${path}`, {
    headers: { host: "relay.example.test", ...(authorization ? { authorization: `Bearer ${authorization}` } : {}) },
  })
}

function publish(body: unknown, headers: Record<string, string> = {}, authorization = token): Request {
  return new Request(`${base}/api/team/relay`, {
    method: "POST",
    headers: {
      host: "relay.example.test",
      authorization: `Bearer ${authorization}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "av-team-gateway-"))
  url = `file:${join(root, "teams.db")}`
  admin = new TursoTeamStore({ url })
  await admin.initialize()
  await admin.ensureTeam({ id: teamId, name: "Alpha", slug: "alpha" })
  await admin.ensureTeam({ id: otherTeamId, name: "Beta", slug: "beta" })
  token = (
    await admin.issueToken({ teamId, userId, displayName: "Alice", role: "member", expiresAt: Date.now() + 60_000 })
  ).token
  otherToken = (
    await admin.issueToken({
      teamId: otherTeamId,
      userId: otherUserId,
      displayName: "Bob",
      role: "owner",
      expiresAt: Date.now() + 60_000,
    })
  ).token
  deps = { loadConfig: () => ({ tursoUrl: url }), env: {} }
})

afterEach(async () => {
  admin.close()
  await rm(root, { recursive: true, force: true })
})

describe("Turso team HTTP gateway", () => {
  it("authenticates opaque team tokens independently of dashboard sessions and never exposes database credentials", async () => {
    const missing = await readTeamSession(request(`/api/team/session?team_id=${teamId}`, ""), deps)
    expect(missing.status).toBe(401)
    const cookieOnly = new Request(`${base}/api/team/session?team_id=${teamId}`, {
      headers: { cookie: "av_status_session=dashboard-session", host: "relay.example.test" },
    })
    expect((await readTeamSession(cookieOnly, deps)).status).toBe(401)
    const response = await readTeamSession(request(`/api/team/session?team_id=${teamId}`), deps)
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const body = await response.json()
    expect(body).toMatchObject({ identity: { userId, teamId, displayName: "Alice", role: "member" } })
    expect(JSON.stringify(body)).not.toContain(token)
    expect(JSON.stringify(body)).not.toContain(url)
  })

  it("isolates team reads and rejects expired or revoked tokens using the same public session error", async () => {
    const wrongTeam = await readTeamEvents(request(`/api/team/relay?team_id=${teamId}`, otherToken), deps)
    expect(wrongTeam.status).toBe(401)
    expect(await wrongTeam.json()).toMatchObject({ code: "session_invalid" })
    await admin.revokeTokens(teamId, userId)
    const revoked = await readTeamSession(request(`/api/team/session?team_id=${teamId}`), deps)
    expect(revoked.status).toBe(401)
    await admin.client.execute({
      sql: "update team_tokens set expires_at=? where user_id=?",
      args: [Date.now() - 1, otherUserId],
    })
    const expired = await readTeamSession(request(`/api/team/session?team_id=${otherTeamId}`, otherToken), deps)
    expect(expired.status).toBe(401)
    expect(await expired.json()).toEqual(await revoked.json())
  })

  it("publishes a bounded validated event and returns only ordered team events with a cursor", async () => {
    const response = await publishTeamEvent(publish({ teamId, eventId: "native-1", event: event() }), deps)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    await admin.publish(otherToken, otherTeamId, "other-team", event(`${otherUserId}:desktop`))
    const listed = await readTeamEvents(request(`/api/team/relay?team_id=${teamId}&after=0&limit=1`), deps)
    expect(listed.status).toBe(200)
    expect(listed.headers.get("cache-control")).toBe("no-store")
    const body = await listed.json()
    expect(body.events).toHaveLength(1)
    expect(body.events[0]).toMatchObject({ v: 1, nodeId: `${userId}:desktop`, type: "node.join" })
    expect(
      (
        await (
          await readTeamEvents(request(`/api/team/relay?team_id=${teamId}&after=${body.events[0].seq}`), deps)
        ).json()
      ).events,
    ).toEqual([])
  })

  it("rejects spoofed user identity and node ownership while allowing originless CLI requests", async () => {
    const spoofed = await publishTeamEvent(
      publish({ teamId, eventId: "spoofed", event: event(), userId: otherUserId }),
      deps,
    )
    expect(spoofed.status).toBe(400)
    const foreignNode = await publishTeamEvent(
      publish({ teamId, eventId: "foreign-node", event: event(`${otherUserId}:desktop`) }),
      deps,
    )
    expect(foreignNode.status).toBe(403)
    expect(await foreignNode.json()).toMatchObject({ code: "node_access_denied" })
    expect((await publishTeamEvent(publish({ teamId, eventId: "native-allowed", event: event() }), deps)).status).toBe(
      200,
    )
  })

  it("requires a matching Origin for browser writes and accepts the local browser origin", async () => {
    const body = { teamId, eventId: "origin-check", event: event() }
    expect((await publishTeamEvent(publish(body, { origin: "https://other.example.test" }), deps)).status).toBe(403)
    expect((await publishTeamEvent(publish(body, { origin: base }), deps)).status).toBe(200)
  })

  it.each([
    `team_id=${teamId}&after=-1`,
    `team_id=${teamId}&after=9007199254740992`,
    `team_id=${teamId}&limit=1001`,
    `team_id=${teamId}&limit=0`,
    `team_id=${teamId}&team_id=${otherTeamId}`,
    `team_id=${teamId}&turso_url=file:attacker.db`,
    "team_id=invalid",
  ])("rejects invalid or injected query parameters: %s", async (query) => {
    const createStore = vi.fn(() => new TursoTeamStore({ url }))
    const response = await readTeamEvents(request(`/api/team/relay?${query}`), { ...deps, createStore })
    expect(response.status).toBe(400)
    expect(createStore).not.toHaveBeenCalled()
  })

  it("enforces body size from both streamed bytes and declared length before opening the database", async () => {
    const createStore = vi.fn(() => new TursoTeamStore({ url }))
    const oversized = publish({ teamId, eventId: "too-big", event: event(), padding: "x".repeat(64_000) })
    expect((await publishTeamEvent(oversized, { ...deps, createStore })).status).toBe(413)
    const declared = publish({ teamId, eventId: "declared-too-big", event: event() }, { "content-length": "64001" })
    expect((await publishTeamEvent(declared, { ...deps, createStore })).status).toBe(413)
    const invalid = new Request(`${base}/api/team/relay`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{",
    })
    expect((await publishTeamEvent(invalid, { ...deps, createStore })).status).toBe(400)
    expect(createStore).not.toHaveBeenCalled()
  })

  it("fails closed for absent remote database credentials and redacts unexpected database errors", async () => {
    const createStore = vi.fn(() => new TursoTeamStore({ url }))
    const unavailable = await readTeamSession(request(`/api/team/session?team_id=${teamId}`), {
      loadConfig: () => ({ tursoUrl: "libsql://configured.example.test", tursoAuthTokenEnv: "PRIVATE_DATABASE_TOKEN" }),
      env: {},
      createStore,
    })
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toMatchObject({ code: "team_config_incomplete" })
    expect(createStore).not.toHaveBeenCalled()
    const secret = "sensitive-database-token"
    const failure = await readTeamSession(request(`/api/team/session?team_id=${teamId}`), {
      ...deps,
      createStore: () => {
        throw new Error(`${url} ${secret}`)
      },
    })
    expect(failure.status).toBe(503)
    expect(JSON.stringify(await failure.json())).not.toContain(secret)
  })

  it("rejects embedded database credentials and returns only allowlisted relay errors", async () => {
    const createStore = vi.fn(() => new TursoTeamStore({ url }))
    const invalid = await readTeamSession(request(`/api/team/session?team_id=${teamId}`), {
      loadConfig: () => ({ tursoUrl: "libsql://configured.example.test?authToken=embedded-secret" }),
      env: {},
      createStore,
    })
    expect(invalid.status).toBe(503)
    expect(await invalid.json()).toMatchObject({ code: "team_config_invalid" })
    expect(createStore).not.toHaveBeenCalled()
    for (const code of ["session_invalid", "constructor", "private-database-detail"]) {
      const response = await readTeamSession(request(`/api/team/session?team_id=${teamId}`), {
        ...deps,
        createStore: () => {
          throw new TeamRelayError(code, "sensitive-backend-message", 401)
        },
      })
      expect(response.status).toBe(code === "session_invalid" ? 401 : 503)
      const serialized = JSON.stringify(await response.json())
      expect(serialized).not.toContain("sensitive-backend-message")
      expect(serialized).not.toContain("private-database-detail")
    }
  })

  it("closes each request-scoped store after authentication failure and never runs schema initialization", async () => {
    const close = vi.fn()
    const createStore = () => {
      const store = new TursoTeamStore({ url })
      const original = store.close.bind(store)
      store.close = () => {
        close()
        original()
      }
      return store
    }
    expect(
      (await readTeamSession(request(`/api/team/session?team_id=${teamId}`, "invalid-token"), { ...deps, createStore }))
        .status,
    ).toBe(401)
    expect(close).toHaveBeenCalledOnce()
    const emptyUrl = `file:${join(root, "uninitialized.db")}`
    const empty = await readTeamSession(request(`/api/team/session?team_id=${teamId}`), {
      loadConfig: () => ({ tursoUrl: emptyUrl }),
      env: {},
    })
    expect(empty.status).toBe(503)
    const inspect = new TursoTeamStore({ url: emptyUrl })
    try {
      expect((await inspect.client.execute("select name from sqlite_master where type='table'")).rows).toEqual([])
    } finally {
      inspect.close()
    }
  })
})
