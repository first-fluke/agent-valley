import { buildAgentEnv, getAgentAuthEnvKeys } from "@agent-valley/core/sessions/base-session"
import { describe, expect, it, vi } from "vitest"
import { type DiscoveryDeps, discoverAgents } from "../agent-discovery"
import { AGENT_BINARY, AGENT_INSTALL_HINT, AGENT_LOGIN_HINT, AGENT_TYPES } from "../doctor-checks"

const SECRET = "qwen-test-secret-never-print"
const NOW = 1_000_000
async function check(
  settings: unknown = null,
  env: NodeJS.ProcessEnv = {},
  path = "/home/test/.qwen/settings.json",
  extraFiles: Record<string, unknown> = {},
) {
  const files = { ...extraFiles, ...(settings === null ? {} : { [path]: settings }) }
  const probe = vi.fn()
  const deps: Partial<DiscoveryDeps> = {
    home: "/home/test",
    env,
    now: () => NOW,
    resolveBinary: (name) => (name === "qwen" ? "/bin/qwen" : null),
    isExecutableFile: () => true,
    fileInfo: (file) => (Object.hasOwn(files, file) ? { isFile: true, size: 100 } : null),
    readFile: (file) => (typeof files[file] === "string" ? files[file] : JSON.stringify(files[file])),
    probe,
  }
  const all = await discoverAgents(deps)
  const result = all.find((entry) => entry.agentType === "qwen")
  expect(result).toBeDefined()
  expect(JSON.stringify(all)).not.toContain(SECRET)
  expect(probe).not.toHaveBeenCalled()
  if (!result) throw new Error("Qwen discovery result missing")
  return result
}
const profile = (protocol = "openai", key = "OPENAI_API_KEY") => ({
  security: { auth: { selectedType: protocol } },
  model: { name: "test-model" },
  modelProviders: { [protocol]: [{ id: "test-model", envKey: key, baseUrl: "https://provider.invalid/v1" }] },
})

describe("Qwen Code readiness", () => {
  it("is part of executable discovery and uses documented install and TUI auth instructions", () => {
    expect(AGENT_TYPES).toContain("qwen")
    expect(AGENT_BINARY.qwen).toBe("qwen")
    expect(AGENT_INSTALL_HINT.qwen).toContain("@qwen-code/qwen-code")
    expect(AGENT_LOGIN_HINT.qwen).toContain("/auth")
  })
  it("recognizes configured OpenAI-compatible models and credentials", async () => {
    expect((await check(profile(), { OPENAI_API_KEY: SECRET })).readiness).toBe("ready")
    expect((await check(null, { OPENAI_API_KEY: SECRET, OPENAI_MODEL: "test-model" })).readiness).toBe("ready")
    expect((await check(null, { OPENAI_API_KEY: SECRET, QWEN_MODEL: "test-model" })).readiness).toBe("ready")
  })
  it.each(["anthropic", "gemini"] as const)("recognizes configured %s credentials", async (protocol) => {
    const key = protocol === "anthropic" ? "ANTHROPIC_API_KEY" : "GEMINI_API_KEY"
    expect((await check(profile(protocol, key), { [key]: SECRET })).readiness).toBe("ready")
  })
  it("requires Anthropic's native endpoint configuration", async () => {
    expect((await check(null, { ANTHROPIC_API_KEY: SECRET, ANTHROPIC_MODEL: "test-model" })).readiness).toBe("unknown")
    expect(
      (
        await check(null, {
          ANTHROPIC_API_KEY: SECRET,
          ANTHROPIC_MODEL: "test-model",
          ANTHROPIC_BASE_URL: "https://provider.invalid",
        })
      ).readiness,
    ).toBe("ready")
  })
  it("accepts configured provider-specific credentials and locally saved native fallback env", async () => {
    expect((await check(profile("openai", "DASHSCOPE_API_KEY"), { DASHSCOPE_API_KEY: SECRET })).readiness).toBe("ready")
    expect((await check(profile("openai", "QWENCLOUD_API_KEY"), { QWENCLOUD_API_KEY: SECRET })).readiness).toBe("ready")
    expect(
      (await check(profile("openai", "QWENCLOUD_TOKEN_PLAN_API_KEY"), { QWENCLOUD_TOKEN_PLAN_API_KEY: SECRET }))
        .readiness,
    ).toBe("ready")
    expect((await check({ ...profile(), env: { OPENAI_API_KEY: SECRET } })).readiness).toBe("ready")
    expect(
      (await check({ ...profile("openai", "PRIVATE_PROVIDER_KEY"), env: { PRIVATE_PROVIDER_KEY: SECRET } })).readiness,
    ).toBe("ready")
  })
  it("does not use shell credential names that native sessions strip", async () => {
    expect((await check(profile("openai", "PRIVATE_PROVIDER_KEY"), { PRIVATE_PROVIDER_KEY: SECRET })).readiness).toBe(
      "unauthenticated",
    )
  })
  it("does not mistake URLs/model names or unrelated credentials for selected-provider auth", async () => {
    expect((await check(profile(), { ANTHROPIC_API_KEY: SECRET, OPENAI_BASE_URL: SECRET })).readiness).toBe(
      "unauthenticated",
    )
    expect((await check(null, { OPENAI_API_KEY: SECRET })).readiness).toBe("unknown")
    expect((await check(null, { DASHSCOPE_API_KEY: SECRET, OPENAI_MODEL: "test-model" })).readiness).toBe("unknown")
    expect((await check(profile(), { OPENAI_API_KEY: " " })).readiness).toBe("unauthenticated")
  })
  it("requires complete selected OAuth credentials and matching API-provider models", async () => {
    expect(
      (await check({ ...profile(), security: { auth: { selectedType: "qwen-oauth" } } }, { OPENAI_API_KEY: SECRET }))
        .readiness,
    ).toBe("unauthenticated")
    expect((await check({ ...profile(), model: { name: "missing" } }, { OPENAI_API_KEY: SECRET })).readiness).toBe(
      "unknown",
    )
    expect(
      (await check({ security: { auth: { selectedType: "unsupported" } } }, { OPENAI_API_KEY: SECRET })).readiness,
    ).toBe("unknown")
  })
  it("recognizes selected Qwen subscription OAuth with native model defaults", async () => {
    const settings = { security: { auth: { selectedType: "qwen-oauth" } } }
    const credentials = { access_token: SECRET, refresh_token: SECRET, token_type: "Bearer", expiry_date: NOW + 60_000 }
    expect((await check(settings, {}, undefined, { "/home/test/.qwen/oauth_creds.json": credentials })).readiness).toBe(
      "ready",
    )
    expect(
      (
        await check(settings, { QWEN_HOME: "/custom/qwen" }, "/custom/qwen/settings.json", {
          "/custom/qwen/oauth_creds.json": credentials,
        })
      ).readiness,
    ).toBe("ready")
  })
  it("keeps expired or refresh-due Qwen OAuth unverified without running a refresh request", async () => {
    const settings = { security: { auth: { selectedType: "qwen-oauth" } } }
    for (const expiry_date of [NOW - 1, NOW + 30_000]) {
      const credentials = { access_token: SECRET, refresh_token: SECRET, token_type: "Bearer", expiry_date }
      const result = await check(settings, {}, undefined, { "/home/test/.qwen/oauth_creds.json": credentials })
      expect(result.readiness).toBe("unknown")
      expect(result.reason).toContain("refresh")
    }
  })
  it("rejects malformed OAuth credential fields without leaking saved tokens", async () => {
    const settings = { security: { auth: { selectedType: "qwen-oauth" } } }
    for (const credentials of [
      { access_token: SECRET, expiry_date: NOW + 60_000 },
      { access_token: SECRET, refresh_token: SECRET, token_type: "Bearer", expiry_date: "future" },
    ]) {
      expect(
        (await check(settings, {}, undefined, { "/home/test/.qwen/oauth_creds.json": credentials })).readiness,
      ).toBe("unauthenticated")
    }
  })
  it("respects absolute and tilde QWEN_HOME without repurposing HOME", async () => {
    expect(
      (await check(profile(), { QWEN_HOME: "/custom/qwen", OPENAI_API_KEY: SECRET }, "/custom/qwen/settings.json"))
        .readiness,
    ).toBe("ready")
    expect(
      (
        await check(
          profile(),
          { QWEN_HOME: "~/custom-qwen", OPENAI_API_KEY: SECRET },
          "/home/test/custom-qwen/settings.json",
        )
      ).readiness,
    ).toBe("ready")
    expect((await check(profile(), { QWEN_HOME: "relative-profile", OPENAI_API_KEY: SECRET })).reason).toContain(
      "absolute QWEN_HOME",
    )
  })
  it("keeps unreadable and malformed auth state actionable without leaking parser errors", async () => {
    expect((await check("{invalid-json-with-SECRET}")).readiness).toBe("unknown")
  })
  it("forwards native provider/profile settings but excludes configuration from credential names", () => {
    const source = {
      QWEN_HOME: "/custom/qwen",
      OPENAI_BASE_URL: "https://provider.invalid",
      OPENAI_MODEL: "test-model",
      OPENAI_API_KEY: SECRET,
      ANTHROPIC_API_KEY: SECRET,
      GEMINI_API_KEY: SECRET,
      DASHSCOPE_API_KEY: SECRET,
      QWENCLOUD_API_KEY: SECRET,
      QWENCLOUD_TOKEN_PLAN_API_KEY: SECRET,
      PRIVATE_PROVIDER_KEY: SECRET,
    }
    const forwarded = buildAgentEnv("qwen", { AGENT_VALLEY_MANAGED_RUN: "1" }, source)
    const { PRIVATE_PROVIDER_KEY: _secret, ...expected } = source
    expect(forwarded).toMatchObject({ ...expected, AGENT_VALLEY_MANAGED_RUN: "1" })
    expect(forwarded).not.toHaveProperty("PRIVATE_PROVIDER_KEY")
    expect(getAgentAuthEnvKeys("qwen")).toContain("DASHSCOPE_API_KEY")
    expect(getAgentAuthEnvKeys("qwen")).not.toContain("QWEN_HOME")
    expect(getAgentAuthEnvKeys("qwen")).not.toContain("OPENAI_BASE_URL")
    expect(getAgentAuthEnvKeys("qwen")).not.toContain("OPENAI_MODEL")
  })
})
