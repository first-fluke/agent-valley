import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import { normalizeTeamRelayUrl, TeamConfigMigrationError, teamConfigSchema } from "./team-schema"
import { globalConfigSchema, isTeamMode, loadGlobalConfig, loadProjectConfig, resolveConfig } from "./yaml-loader"

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "av-team-config-"))
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

it.each(["https://team.example.com/", " http://localhost:9741/ ", "http://127.0.0.1:9741/base/", "http://[::1]:9741/"])(
  "accepts safe gateways: %s",
  (value) => {
    expect(normalizeTeamRelayUrl(value)).not.toMatch(/\/$/)
  },
)
it.each([
  "http://team.example.com",
  "http://localhost.evil.example",
  "file:///tmp/gateway",
  "https://user:secret@team.example.com",
  "https://team.example.com?q=1",
  "https://team.example.com?",
  "https://team.example.com#",
  "https://team.example.com/#fragment",
  "https://team.\nexample.com",
])("rejects unsafe gateways: %s", (value) => {
  expect(() => normalizeTeamRelayUrl(value)).toThrow("team.relay_url")
})
it("rejects retired keys in either config file without including their values", () => {
  const value = "DO_NOT_INCLUDE_LEGACY_KEY_VALUE"
  for (const key of ["supabase_url", "supabase_anon_key"]) {
    for (const filename of ["settings.yaml", "av.yaml"]) {
      const path = join(directory, filename)
      writeFileSync(path, `team:\n  ${key}: ${value}\n`)
      const load = filename === "settings.yaml" ? () => loadGlobalConfig(path) : () => loadProjectConfig(directory)
      expect(load).toThrow(TeamConfigMigrationError)
      try {
        load()
      } catch (error) {
        const message = (error as Error).message
        expect(message).toContain(path)
        expect(message).toContain(`team.${key}`)
        expect(message).toContain("team.relay_url")
        expect(message).toContain("team.turso_auth_token_env")
        expect(message).not.toContain(value)
      }
    }
    const result = globalConfigSchema.safeParse({ team: { [key]: value } })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.message).toContain("team.relay_url")
  }
})
it("keeps user tokens out of team YAML", () => {
  expect(teamConfigSchema.safeParse({ relay_url: "https://team.example.com", token: "do-not-store" }).success).toBe(
    false,
  )
  expect(teamConfigSchema.safeParse({ turso_auth_token_env: "TOKEN=secret" }).success).toBe(false)
})
it("enables client mode without a database credential and merges server metadata separately", () => {
  const project = {
    tracker: { kind: "github" as const },
    github: {
      owner: "team",
      repo: "repo",
      token_env: "GITHUB_TOKEN",
      webhook_secret: "test-secret",
      labels: { todo: "todo", in_progress: "wip", done: "done", cancelled: "cancelled" },
    },
    workspace: { root: "/tmp/workspace" },
    prompt: "work",
    team: { relay_url: "https://project.example.com", id: "5fa388f1-325b-49e6-ae65-cafddfd493be" },
  }
  const global = {
    team: {
      relay_url: "https://global.example.com",
      id: "d351e4cb-42b3-4bb3-88fe-fd2902895766",
      turso_url: "libsql://central.turso.io",
      display_name: "Member",
    },
  }
  const config = resolveConfig(global, project, { GITHUB_TOKEN: "test-token" })
  expect(isTeamMode(config)).toBe(true)
  expect(config.teamRelayUrl).toBe("https://project.example.com")
  expect(config.teamId).toBe("5fa388f1-325b-49e6-ae65-cafddfd493be")
  expect(config.tursoUrl).toBe("libsql://central.turso.io")
  expect(config.tursoAuthTokenEnv).toBe("TURSO_AUTH_TOKEN")
  expect(config.displayName).toBe("Member")
  expect(config).not.toHaveProperty("tursoAuthToken")
  expect(isTeamMode({ ...config, teamRelayUrl: undefined })).toBe(false)
  expect(isTeamMode({ ...config, teamId: undefined })).toBe(false)
})
