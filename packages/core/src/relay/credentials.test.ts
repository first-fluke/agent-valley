import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadRelayCredentials, validateRelayCredentials } from "./credentials"

const now = 1_900_000_000_000
const credentials = {
  accessToken: "test-user-team-token",
  userId: "d351e4cb-42b3-4bb3-88fe-fd2902895766",
  teamId: "5fa388f1-325b-49e6-ae65-cafddfd493be",
  relayUrl: "https://team.example.com/gateway",
  expiresAt: now + 60_000,
  displayName: "Tester",
}
const binding = { relayUrl: credentials.relayUrl, teamId: credentials.teamId }

it("normalizes and binds the gateway URL, base path and team", () => {
  expect(validateRelayCredentials({ ...credentials, relayUrl: `${credentials.relayUrl}/` }, binding, now)).toEqual(
    credentials,
  )
  for (const relayUrl of [
    "https://other.example.com/gateway",
    "https://team.example.com/other",
    "http://team.example.com/gateway",
  ])
    expect(validateRelayCredentials(credentials, { ...binding, relayUrl }, now)).toBeNull()
  expect(validateRelayCredentials(credentials, { ...binding, teamId: credentials.userId }, now)).toBeNull()
})

it.each([
  { ...credentials, expiresAt: now },
  { ...credentials, expiresAt: 0 },
  { ...credentials, expiresAt: Number.POSITIVE_INFINITY },
  { ...credentials, expiresAt: "2100000000000" },
  { ...credentials, accessToken: "" },
  { ...credentials, accessToken: { token: "test" } },
  { ...credentials, userId: "not-a-uuid" },
  { ...credentials, teamId: "not-a-uuid" },
  { ...credentials, relayUrl: "https://user:password@team.example.com" },
  { ...credentials, refreshToken: "retired" },
  { accessToken: "retired", userId: credentials.userId, supabaseUrl: "https://old.example.com", expiresAt: now + 1 },
])("rejects malformed, expired and legacy sessions", (value) => {
  expect(validateRelayCredentials(value, undefined, now)).toBeNull()
})

it("permits a loopback gateway without weakening remote transport", () => {
  expect(validateRelayCredentials({ ...credentials, relayUrl: "http://127.0.0.1:9741" }, undefined, now)).not.toBeNull()
})

describe("loadRelayCredentials", () => {
  let directory: string
  let path: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "av-credentials-"))
    path = join(directory, "credentials.json")
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))
  it("returns null for missing, empty and corrupt files", () => {
    expect(loadRelayCredentials(path, binding, now)).toBeNull()
    for (const content of ["", "{broken", "null", "{}"]) {
      writeFileSync(path, content)
      expect(loadRelayCredentials(path, binding, now)).toBeNull()
    }
  })
  it("applies the same checks to a stored session", () => {
    writeFileSync(path, JSON.stringify(credentials))
    expect(loadRelayCredentials(path, binding, now)).toEqual(credentials)
    expect(loadRelayCredentials(path, binding, credentials.expiresAt)).toBeNull()
    expect(loadRelayCredentials(path, { ...binding, relayUrl: "https://untrusted.example.com" }, now)).toBeNull()
  })
})
