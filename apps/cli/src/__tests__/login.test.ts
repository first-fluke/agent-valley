import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as p from "@clack/prompts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearCredentials, loadCredentials, login, logout, saveCredentials } from "../login"

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  confirm: vi.fn(),
  password: vi.fn(),
  isCancel: (value: unknown) => typeof value === "symbol",
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  log: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}))

const binding = { relayUrl: "https://team.example.com/gateway", teamId: "5fa388f1-325b-49e6-ae65-cafddfd493be" }
const token = "test-user-team-token"
const userId = "d351e4cb-42b3-4bb3-88fe-fd2902895766"
const identity = () => ({
  userId,
  teamId: binding.teamId,
  displayName: "Tester",
  role: "member" as const,
  expiresAt: Date.now() + 60_000,
})
const credentials = () => ({
  accessToken: token,
  userId,
  ...binding,
  displayName: "Tester",
  expiresAt: Date.now() + 60_000,
})
let directory: string
let path: string
let previousExitCode: string | number | null | undefined
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "av-cli-login-"))
  path = join(directory, "credentials.json")
  previousExitCode = process.exitCode
  process.exitCode = undefined
  vi.clearAllMocks()
  vi.mocked(p.password).mockResolvedValue(token)
})
afterEach(() => {
  process.exitCode = previousExitCode
  rmSync(directory, { recursive: true, force: true })
})

function dependencies(session = identity()) {
  const getSession = vi.fn().mockResolvedValue(session)
  const createClient = vi.fn(() => ({ getSession }))
  return { loadTeamConfig: () => binding, createClient, credentialsPath: path, getSession }
}

it("stores only the verified, endpoint-bound identity with private file permissions", () => {
  const value = credentials()
  writeFileSync(path, "retired-session", { mode: 0o644 })
  saveCredentials(value, path)
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(value)
  expect(loadCredentials(path, binding)).toEqual(value)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(statSync(directory).mode & 0o777).toBe(0o700)
  expect(readdirSync(directory)).toEqual(["credentials.json"])
  const saved = readFileSync(path, "utf8")
  expect(() => saveCredentials({ ...value, expiresAt: Date.now() - 1 }, path)).toThrow("expired")
  expect(readFileSync(path, "utf8")).toBe(saved)
})

it("validates the user token with the configured gateway before saving", async () => {
  const deps = dependencies()
  await login(deps)
  expect(deps.createClient).toHaveBeenCalledWith({ ...binding, token })
  expect(deps.getSession).toHaveBeenCalledOnce()
  const stored = loadCredentials(path, binding)
  expect(stored).toMatchObject({ ...binding, userId, accessToken: token })
  expect(stored).not.toHaveProperty("role")
  expect(stored).not.toHaveProperty("refreshToken")
  expect(JSON.stringify([vi.mocked(p.log.info).mock.calls, vi.mocked(p.log.success).mock.calls])).not.toContain(token)
  expect(process.exitCode).toBeUndefined()
})

it.each([
  { ...identity(), teamId: userId },
  { ...identity(), userId: "invalid" },
  { ...identity(), expiresAt: Date.now() - 1 },
])("refuses a mismatched or invalid server identity", async (session) => {
  await login(dependencies(session))
  expect(existsSync(path)).toBe(false)
  expect(process.exitCode).toBe(1)
  expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("expired or mismatched"))
})

it("keeps a valid matching login when relogin is declined", async () => {
  saveCredentials(credentials(), path)
  vi.mocked(p.confirm).mockResolvedValue(false)
  const deps = dependencies()
  await login(deps)
  expect(p.password).not.toHaveBeenCalled()
  expect(deps.createClient).not.toHaveBeenCalled()
  expect(loadCredentials(path, binding)).not.toBeNull()
})

it("requires reauthentication for another gateway or team without sending the stored token", async () => {
  saveCredentials({ ...credentials(), relayUrl: "https://other.example.com", accessToken: "other-server-token" }, path)
  const deps = dependencies()
  await login(deps)
  expect(p.confirm).not.toHaveBeenCalled()
  expect(deps.createClient).toHaveBeenCalledWith({ ...binding, token })
  expect(loadCredentials(path, binding)?.accessToken).toBe(token)
})

it("replaces a legacy Supabase cache only after a successful gateway login", async () => {
  writeFileSync(
    path,
    JSON.stringify({
      accessToken: "retired-token",
      refreshToken: "retired-refresh",
      supabaseUrl: "https://old.example.com",
      userId,
      email: "old@example.com",
      expiresAt: Date.now() + 60_000,
    }),
  )
  const deps = dependencies()
  await login(deps)
  expect(p.confirm).not.toHaveBeenCalled()
  expect(loadCredentials(path, binding)?.accessToken).toBe(token)
  expect(readFileSync(path, "utf8")).not.toContain("retired")
})

it("does not dispatch a token to an unsafe URL", async () => {
  const deps = dependencies()
  await login({ ...deps, loadTeamConfig: () => ({ ...binding, relayUrl: "http://remote.example.com" }) })
  expect(deps.createClient).not.toHaveBeenCalled()
  expect(p.password).not.toHaveBeenCalled()
  expect(existsSync(path)).toBe(false)
  expect(process.exitCode).toBe(1)
})

it("does not overwrite an existing cache after a failed token verification and redacts the token", async () => {
  writeFileSync(path, "existing-session")
  const deps = dependencies()
  deps.getSession.mockRejectedValue(new Error(`Gateway rejected ${token}`))
  await login(deps)
  expect(readFileSync(path, "utf8")).toBe("existing-session")
  expect(p.log.error).toHaveBeenCalledWith("Gateway rejected [redacted]")
  expect(process.exitCode).toBe(1)
})

it("cancels without replacing credentials or making a request", async () => {
  const cancelled = Symbol("cancelled")
  vi.mocked(p.password).mockResolvedValue(cancelled as unknown as Awaited<ReturnType<typeof p.password>>)
  const deps = dependencies()
  await login(deps)
  expect(deps.createClient).not.toHaveBeenCalled()
  expect(existsSync(path)).toBe(false)
  expect(process.exitCode).toBeUndefined()
})

describe("logout", () => {
  it("deletes the local session idempotently", async () => {
    saveCredentials(credentials(), path)
    await logout(path)
    expect(existsSync(path)).toBe(false)
    expect(() => clearCredentials(path)).not.toThrow()
    expect(loadCredentials(path)).toBeNull()
  })
})
