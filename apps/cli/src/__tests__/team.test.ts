import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadRelayCredentials } from "@agent-valley/core/relay/credentials"
import { TursoTeamStore } from "@agent-valley/core/relay/turso-team-store"
import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { stringify } from "yaml"
import { registerTeamCommands } from "../team"

const teamId = "5fa388f1-325b-49e6-ae65-cafddfd493be"
const ownerId = "d351e4cb-42b3-4bb3-88fe-fd2902895766"
const memberId = "fd6e744f-70d0-4f98-bab8-e20b5cdbf741"
const relayUrl = "https://team.example.com/gateway"
const tokenEnv = "AV_ADMIN_TEST_TURSO_TOKEN"
let root: string
let projectRoot: string
let credentialsPath: string
let url: string
let previousXdg: string | undefined
let previousDbToken: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "av-team-admin-"))
  projectRoot = join(root, "project")
  credentialsPath = join(root, "credentials", "credentials.json")
  url = `file:${join(root, "team.sqlite")}`
  mkdirSync(projectRoot)
  previousXdg = process.env.XDG_CONFIG_HOME
  previousDbToken = process.env[tokenEnv]
  process.env.XDG_CONFIG_HOME = join(root, "xdg")
  delete process.env[tokenEnv]
  writeConfig()
  vi.spyOn(console, "log").mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = previousXdg
  if (previousDbToken === undefined) delete process.env[tokenEnv]
  else process.env[tokenEnv] = previousDbToken
  rmSync(root, { recursive: true, force: true })
})

function writeConfig(databaseUrl = url): void {
  writeFileSync(
    join(projectRoot, "av.yaml"),
    stringify({ team: { id: teamId, relay_url: relayUrl, turso_url: databaseUrl, turso_auth_token_env: tokenEnv } }),
  )
}

async function run(args: string[]): Promise<void> {
  const program = new Command().exitOverride()
  registerTeamCommands(program, { projectRoot, credentialsPath })
  await program.parseAsync(["team", ...args], { from: "user" })
}

async function initialize(): Promise<void> {
  await run([
    "init",
    "--name",
    "Offline team",
    "--slug",
    "offline-team",
    "--user-id",
    ownerId,
    "--display-name",
    "Owner tester",
  ])
}

function ownerToken(): string {
  const credentials = loadRelayCredentials(credentialsPath, { relayUrl, teamId })
  if (!credentials) throw new Error("Expected an owner session fixture")
  return credentials.accessToken
}

async function addMember(file = "member.token"): Promise<string> {
  await run(["add-member", "--name", "Member tester", "--user-id", memberId, "--token-file", file])
  return readFileSync(join(projectRoot, file), "utf8").trim()
}

function stdout(): string {
  return JSON.stringify(vi.mocked(console.log).mock.calls)
}

it("applies pending migrations once on a fresh database without issuing credentials", async () => {
  expect(existsSync(join(root, "team.sqlite"))).toBe(false)
  await run(["migrate"])
  await run(["migrate"])
  const store = new TursoTeamStore({ url })
  try {
    const journal = await store.client.execute("select hash,created_at from __drizzle_migrations")
    expect(journal.rows).toHaveLength(1)
    expect(journal.rows[0]?.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(Number(journal.rows[0]?.created_at)).toBeGreaterThan(0)
    expect((await store.client.execute("select token_hash from team_tokens")).rows).toEqual([])
    expect((await store.client.execute("select user_id from team_members")).rows).toEqual([])
    expect(existsSync(credentialsPath)).toBe(false)
  } finally {
    store.close()
  }
})

it("initializes a team-only project and saves the owner session privately without printing the token", async () => {
  await initialize()
  const token = ownerToken()
  expect(statSync(credentialsPath).mode & 0o777).toBe(0o600)
  expect(statSync(join(root, "credentials")).mode & 0o777).toBe(0o700)
  expect(loadRelayCredentials(credentialsPath, { relayUrl, teamId })).toMatchObject({
    userId: ownerId,
    teamId,
    relayUrl,
    displayName: "Owner tester",
  })
  expect(stdout()).toContain("Team initialized")
  expect(stdout()).not.toContain(token)
  const store = new TursoTeamStore({ url })
  try {
    expect(await store.authenticate(token, teamId)).toMatchObject({ userId: ownerId, teamId, role: "owner" })
    const stored = await store.client.execute("select token_hash from team_tokens")
    expect(stored.rows).toHaveLength(1)
    expect(stored.rows[0]?.token_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(stored.rows)).not.toContain(token)
  } finally {
    store.close()
  }
})

it("writes a new member token to a private file and authenticates the assigned UUID", async () => {
  await initialize()
  vi.mocked(console.log).mockClear()
  const token = await addMember("private/member.token")
  expect(token).toMatch(/^avt_[A-Za-z0-9_-]{43}$/)
  expect(statSync(join(projectRoot, "private/member.token")).mode & 0o777).toBe(0o600)
  expect(statSync(join(projectRoot, "private")).mode & 0o777).toBe(0o700)
  expect(stdout()).toContain(memberId)
  expect(stdout()).not.toContain(token)
  const store = new TursoTeamStore({ url })
  try {
    expect(await store.authenticate(token, teamId)).toMatchObject({
      userId: memberId,
      teamId,
      displayName: "Member tester",
      role: "member",
    })
  } finally {
    store.close()
  }
})

it("rejects an output collision before issuing another token or changing membership", async () => {
  await initialize()
  writeFileSync(join(projectRoot, "member.token"), "existing-private-file")
  const store = new TursoTeamStore({ url })
  try {
    const beforeTokens = await store.client.execute("select token_hash from team_tokens order by token_hash")
    const beforeMembers = await store.client.execute("select user_id,role from team_members order by user_id")
    await expect(addMember()).rejects.toMatchObject({ code: "EEXIST" })
    expect(readFileSync(join(projectRoot, "member.token"), "utf8")).toBe("existing-private-file")
    expect((await store.client.execute("select token_hash from team_tokens order by token_hash")).rows).toEqual(
      beforeTokens.rows,
    )
    expect((await store.client.execute("select user_id,role from team_members order by user_id")).rows).toEqual(
      beforeMembers.rows,
    )
  } finally {
    store.close()
  }
})

it("revokes future authentication while preserving the member's historical events", async () => {
  await initialize()
  const token = await addMember()
  const store = new TursoTeamStore({ url })
  try {
    await store.publish(token, teamId, "member-node-join", {
      type: "node.join",
      nodeId: `${memberId}:offline-machine`,
      clientTimestamp: new Date().toISOString(),
      payload: { defaultAgentType: "codex", maxParallel: 2, displayName: "Member tester" },
    })
    const before = await store.readEvents(ownerToken(), teamId, 0, 100)
    expect(before).toHaveLength(1)
    await run(["revoke", "--user-id", memberId])
    await expect(store.authenticate(token, teamId)).rejects.toMatchObject({ code: "session_invalid", status: 401 })
    expect(await store.readEvents(ownerToken(), teamId, 0, 100)).toEqual(before)
    expect(
      (
        await store.client.execute({
          sql: "select user_id from team_members where team_id=? and user_id=?",
          args: [teamId, memberId],
        })
      ).rows,
    ).toHaveLength(1)
    expect(stdout()).not.toContain(token)
  } finally {
    store.close()
  }
})

describe("validation before database access", () => {
  it.each(["0", "366", "1.5", "NaN", "-1"])(
    "rejects invalid --days %s without creating a database or credential",
    async (days) => {
      await expect(run(["init", "--name", "Offline team", "--slug", "offline-team", "--days", days])).rejects.toThrow(
        "--days",
      )
      expect(existsSync(join(root, "team.sqlite"))).toBe(false)
      expect(existsSync(credentialsPath)).toBe(false)
    },
  )
  it("requires the named server credential before accessing a remote database", async () => {
    writeConfig("libsql://offline-fixture.turso.io")
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external call"))
    await expect(initialize()).rejects.toThrow(`team.turso_auth_token_env (${tokenEnv})`)
    expect(fetcher).not.toHaveBeenCalled()
    expect(existsSync(credentialsPath)).toBe(false)
    expect(stdout()).toBe("[]")
  })
})
