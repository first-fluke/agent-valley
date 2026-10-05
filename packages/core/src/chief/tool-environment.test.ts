import { describe, expect, it } from "vitest"
import { chiefConfigSchema } from "../config/chief-schema"
import { buildAgentEnv } from "../sessions/base-session"
import { resolveToolEnvironment } from "./tool-environment"

describe("explicit tool credentials", () => {
  it("forwards only named values alongside the minimal native Actor environment", () => {
    const source = {
      PATH: "/usr/bin",
      HOME: "/user",
      AWS_SECRET_ACCESS_KEY: "fake-credential",
      UNRELATED_TOKEN: "hidden",
    }
    const keys = chiefConfigSchema.parse({ tool_env_keys: ["AWS_SECRET_ACCESS_KEY"] }).tool_env_keys
    const env = buildAgentEnv("codex", resolveToolEnvironment(keys, source), source)
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("fake-credential")
    expect(env.UNRELATED_TOKEN).toBeUndefined()
    expect(JSON.stringify(keys)).not.toContain("fake-credential")
    expect(buildAgentEnv("codex", {}, source).AWS_SECRET_ACCESS_KEY).toBeUndefined()
  })
  it("fails with a fix and name when an explicitly required value is missing", () => {
    expect(() => resolveToolEnvironment(["SENTRY_AUTH_TOKEN"], {})).toThrow("chief.tool_env_keys")
    expect(() => resolveToolEnvironment(["SENTRY_AUTH_TOKEN"], {})).toThrow("SENTRY_AUTH_TOKEN")
  })
  it.each([
    "NODE_OPTIONS",
    "HOME",
    "PATH",
    "GIT_SSH_COMMAND",
    "DYLD_INSERT_LIBRARIES",
    "AGENT_VALLEY_MANAGED_RUN",
    "bad-key",
  ])("rejects runtime override %s", (key) => {
    expect(() => chiefConfigSchema.parse({ tool_env_keys: [key] })).toThrow()
  })
  it("rejects duplicate names and never forwards extra values by default", () => {
    expect(() => chiefConfigSchema.parse({ tool_env_keys: ["AWS_PROFILE", "AWS_PROFILE"] })).toThrow()
    expect(resolveToolEnvironment(undefined, { AWS_SECRET_ACCESS_KEY: "hidden" })).toEqual({})
  })
})
