import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildAgentEnv, getAgentAuthEnvKeys } from "@agent-valley/core/sessions/base-session"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type AuthProbeResult, type DiscoveryDeps, discoverAgents } from "../agent-discovery"
import { AGENT_BINARY, AGENT_TYPES, type AgentType } from "../doctor-checks"

const NOW = 2_000_000_000_000
const SECRET = "test-only-credential-do-not-disclose"
const dirs: string[] = []

function depsFor(
  agent: AgentType,
  files: Record<string, unknown> = {},
  overrides: Partial<DiscoveryDeps> = {},
): Partial<DiscoveryDeps> {
  return {
    home: "/home/test",
    env: {},
    now: () => NOW,
    resolveBinary: (name) => (name === AGENT_BINARY[agent] ? `/bin/${name}` : null),
    isExecutableFile: () => true,
    fileInfo: (path) => (Object.hasOwn(files, path) ? { isFile: true, size: 100 } : null),
    readFile: (path) => (typeof files[path] === "string" ? (files[path] as string) : JSON.stringify(files[path])),
    parseToml: JSON.parse,
    probe: vi.fn(async () => ({ exitCode: 0, stdout: "Usage: legacy CLI", stderr: "" })),
    ...overrides,
  }
}

async function availability(
  agent: AgentType,
  files: Record<string, unknown> = {},
  overrides: Partial<DiscoveryDeps> = {},
) {
  const results = await discoverAgents(depsFor(agent, files, overrides))
  const result = results.find((entry) => entry.agentType === agent)
  expect(result).toBeDefined()
  expect(JSON.stringify(results)).not.toContain(SECRET)
  if (!result) throw new Error("Missing agent discovery result")
  return result
}

function statusProbe(agent: AgentType, status: AuthProbeResult) {
  return vi.fn(async (_path: string, args: readonly string[]): Promise<AuthProbeResult> => {
    if (args.length === 1 && args[0] === "--help") {
      return {
        exitCode: 0,
        stdout: `Commands:\n  ${agent === "claude" ? "auth" : agent === "codex" ? "login" : "status"}  Authentication`,
        stderr: "",
      }
    }
    if (args.includes("--help"))
      return { exitCode: 0, stdout: "Commands:\n  status  Show authentication status", stderr: "" }
    return status
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("agent discovery", () => {
  it("requires Antigravity's Gemini provider selection and its actual credential environment", async () => {
    const path = "/home/test/.gemini/antigravity-cli/settings.json"
    expect((await availability("antigravity", {}, { env: { GEMINI_API_KEY: SECRET } })).readiness).toBe("unknown")
    expect(
      (await availability("antigravity", { [path]: { modelProvider: "gemini" } }, { env: { GOOGLE_API_KEY: SECRET } }))
        .readiness,
    ).toBe("unauthenticated")
    expect(
      (await availability("antigravity", { [path]: { modelProvider: "gemini" } }, { env: { GEMINI_API_KEY: SECRET } }))
        .readiness,
    ).toBe("ready")
  })
  it("returns all known adapters with actionable installation diagnostics", async () => {
    const results = await discoverAgents(depsFor("codex", {}, { resolveBinary: () => null }))
    expect(results.map((entry) => entry.agentType)).toEqual(AGENT_TYPES)
    for (const result of results) {
      expect(result.readiness).toBe("unavailable")
      expect(result.reason).toContain("Install:")
      expect(result.binaryPath).toBeUndefined()
    }
  })

  it("requires an executable regular file even when credentials are present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "av-discovery-"))
    dirs.push(dir)
    const path = join(dir, "codex")
    const overrides: Partial<DiscoveryDeps> = {
      env: { OPENAI_API_KEY: SECRET },
      resolveBinary: (name) => (name === "codex" ? path : null),
    }
    // Retain the default filesystem executable check, while all auth probes remain injected.
    const deps = depsFor("codex", {}, overrides)
    delete deps.isExecutableFile
    mkdirSync(path)
    expect((await discoverAgents(deps)).find((entry) => entry.agentType === "codex")?.readiness).toBe("unavailable")
    rmSync(path, { recursive: true })
    writeFileSync(path, "test fixture", { mode: 0o600 })
    expect((await discoverAgents(deps)).find((entry) => entry.agentType === "codex")?.readiness).toBe("unavailable")
    chmodSync(path, 0o700)
    expect((await discoverAgents(deps)).find((entry) => entry.agentType === "codex")?.readiness).toBe("ready")
  })

  it.each([
    ["claude", "ANTHROPIC_API_KEY"],
    ["codex", "OPENAI_API_KEY"],
    ["cursor", "CURSOR_API_KEY"],
    ["grok", "XAI_API_KEY"],
    ["opencode", "OPENROUTER_API_KEY"],
  ] as const)("recognizes %s credential environment without spawning a CLI", async (agent, key) => {
    const probe = vi.fn()
    const result = await availability(agent, {}, { env: { [key]: SECRET }, probe })
    expect(result.readiness).toBe("ready")
    expect(result.reason).toContain(key)
    expect(probe).not.toHaveBeenCalled()
  })

  it("does not treat blank keys, endpoint URLs, flags, model names, or configuration paths as credentials", async () => {
    const result = await availability(
      "codex",
      {},
      {
        env: {
          OPENAI_API_KEY: "  ",
          OPENAI_BASE_URL: SECRET,
          CODEX_HOME: "/profile",
          MODEL: "test-model",
          CODEX_QUIET: "1",
        },
      },
    )
    expect(result.readiness).toBe("unknown")
    expect(result.reason).toContain("codex login")
    expect(getAgentAuthEnvKeys("codex")).toEqual(["OPENAI_API_KEY"])
    expect(getAgentAuthEnvKeys("unsupported")).toEqual([])
    expect(Object.isFrozen(getAgentAuthEnvKeys("codex"))).toBe(true)
  })

  it.each([
    ["codex", "CODEX_HOME"],
    ["claude", "CLAUDE_CONFIG_DIR"],
    ["kimi", "KIMI_CODE_HOME"],
    ["opencode", "XDG_DATA_HOME"],
  ] as const)("forwards %s auth configuration path to agent sessions", (agent, key) => {
    vi.stubEnv(key, "/alternate-profile")
    expect(buildAgentEnv(agent)[key]).toBe("/alternate-profile")
    expect(getAgentAuthEnvKeys(agent)).not.toContain(key)
  })

  it("ignores profile directories without credential files", async () => {
    const result = await availability(
      "claude",
      {},
      { fileInfo: (path) => (path.endsWith(".claude") ? { isFile: false, size: 0 } : null) },
    )
    expect(result.readiness).toBe("unknown")
  })

  it("reads Codex auth from CODEX_HOME and validates credential shape", async () => {
    const result = await availability(
      "codex",
      { "/alternate/auth.json": { OPENAI_API_KEY: SECRET } },
      { env: { CODEX_HOME: "/alternate" } },
    )
    expect(result.readiness).toBe("ready")
    for (const auth of [{}, [], { OPENAI_API_KEY: " " }, { tokens: { access_token: SECRET } }]) {
      expect((await availability("codex", { "/home/test/.codex/auth.json": auth })).readiness).toBe("unauthenticated")
    }
  })

  it("accepts complete Codex OAuth state and rejects known expired access tokens", async () => {
    const tokens = { access_token: SECRET, refresh_token: SECRET, id_token: SECRET }
    expect((await availability("codex", { "/home/test/.codex/auth.json": { tokens } })).readiness).toBe("ready")
    const access = `header.${Buffer.from(JSON.stringify({ exp: NOW / 1_000 - 1 })).toString("base64url")}.signature`
    const result = await availability("codex", {
      "/home/test/.codex/auth.json": { tokens: { ...tokens, access_token: access } },
    })
    expect(result.readiness).toBe("unauthenticated")
    expect(result.reason).toContain("expired")
  })

  it("validates Claude OAuth credentials and expiration in the configured directory", async () => {
    const path = "/claude-profile/.credentials.json"
    const oauth = { accessToken: SECRET, refreshToken: SECRET, expiresAt: NOW + 60_000 }
    const overrides = { env: { CLAUDE_CONFIG_DIR: "/claude-profile" } }
    expect((await availability("claude", { [path]: { claudeAiOauth: oauth } }, overrides)).readiness).toBe("ready")
    expect(
      (await availability("claude", { [path]: { claudeAiOauth: { ...oauth, expiresAt: NOW } } }, overrides)).readiness,
    ).toBe("unauthenticated")
    expect(
      (await availability("claude", { [path]: { claudeAiOauth: { ...oauth, accessToken: "" } } }, overrides)).readiness,
    ).toBe("unauthenticated")
  })

  it.each(["claude", "codex"] as const)(
    "uses verified %s native auth for refreshable expired local tokens",
    async (agent) => {
      const files =
        agent === "claude"
          ? {
              "/home/test/.claude/.credentials.json": {
                claudeAiOauth: { accessToken: SECRET, refreshToken: SECRET, expiresAt: NOW - 1 },
              },
            }
          : {
              "/home/test/.codex/auth.json": {
                tokens: { access_token: SECRET, refresh_token: SECRET, id_token: SECRET, expires_at: NOW / 1_000 - 1 },
              },
            }
      const status =
        agent === "claude"
          ? { exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), stderr: "" }
          : { exitCode: 0, stdout: "", stderr: "Logged in using ChatGPT" }
      expect((await availability(agent, files, { probe: statusProbe(agent, status) })).readiness).toBe("ready")
      const loggedOut =
        agent === "claude"
          ? { exitCode: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }), stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "Not logged in" }
      expect((await availability(agent, files, { probe: statusProbe(agent, loggedOut) })).readiness).toBe(
        "unauthenticated",
      )
    },
  )

  it("can verify Claude keychain login despite incomplete or malformed credential files", async () => {
    const status = { exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), stderr: "" }
    for (const value of [{}, "malformed"]) {
      expect(
        (
          await availability(
            "claude",
            { "/home/test/.claude/.credentials.json": value },
            { probe: statusProbe("claude", status) },
          )
        ).readiness,
      ).toBe("ready")
    }
  })

  it.each(["claude", "codex", "opencode", "kimi"] as const)(
    "reports unreadable %s native state without raw errors",
    async (agent) => {
      const result = await availability(
        agent,
        {},
        {
          fileInfo: () => {
            throw new Error(SECRET)
          },
        },
      )
      expect(result.readiness).toBe("unknown")
      expect(result.reason).toContain("could not")
    },
  )

  it("rejects malformed, oversized, and directory auth files", async () => {
    const path = "/home/test/.codex/auth.json"
    expect((await availability("codex", { [path]: "malformed-secret" })).readiness).toBe("unknown")
    for (const info of [
      { isFile: false, size: 0 },
      { isFile: true, size: 1_048_577 },
    ]) {
      const readFile = vi.fn()
      const result = await availability("codex", {}, { fileInfo: () => info, readFile })
      expect(result.readiness).toBe("unknown")
      expect(readFile).not.toHaveBeenCalled()
    }
  })

  it("checks recognized OpenCode auth types and token expiration", async () => {
    const path = "/data/opencode/auth.json"
    const overrides = { env: { XDG_DATA_HOME: "/data" } }
    for (const credential of [
      { type: "api", key: SECRET },
      { type: "oauth", access: SECRET, refresh: SECRET, expires: NOW + 1 },
    ]) {
      expect((await availability("opencode", { [path]: { provider: credential } }, overrides)).readiness).toBe("ready")
    }
    for (const credential of [
      { key: SECRET },
      { type: "api", key: " " },
      { type: "oauth", access: SECRET, refresh: SECRET, expires: NOW - 1 },
    ]) {
      expect((await availability("opencode", { [path]: { provider: credential } }, overrides)).readiness).toBe(
        "unauthenticated",
      )
    }
  })

  it("requires Kimi's selected model provider credentials, not plain shell keys or default_model alone", async () => {
    const path = "/home/test/.kimi-code/config.toml"
    const config = {
      default_model: "main",
      models: { main: { provider: "kimi", model: "kimi-for-coding" } },
      providers: { kimi: { type: "kimi", base_url: "https://api.example.test", api_key: SECRET } },
    }
    expect((await availability("kimi", { [path]: config })).readiness).toBe("ready")
    expect(
      (
        await availability(
          "kimi",
          { [path]: { default_model: "main" } },
          { env: { KIMI_API_KEY: SECRET, MOONSHOT_API_KEY: SECRET } },
        )
      ).readiness,
    ).toBe("unauthenticated")
    const noKey = { ...config, providers: { kimi: { ...config.providers.kimi, api_key: "" } } }
    expect((await availability("kimi", { [path]: noKey })).readiness).toBe("unauthenticated")
  })

  it("reads actual Kimi TOML with the default parser when Bun is unavailable", async () => {
    const path = "/home/test/.kimi-code/config.toml"
    const probe = vi.fn()
    const deps = depsFor(
      "kimi",
      {
        [path]: `default_model = "main"
[models.main]
provider = "kimi"
model = "kimi-for-coding"
[providers.kimi]
type = "kimi"
base_url = "https://api.example.test"
api_key = "${SECRET}"
`,
      },
      { probe },
    )
    delete deps.parseToml
    vi.stubGlobal("Bun", undefined)
    try {
      const results = await discoverAgents(deps)
      expect(results.find((entry) => entry.agentType === "kimi")?.readiness).toBe("ready")
      expect(JSON.stringify(results)).not.toContain(SECRET)
      expect(probe).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("reads Kimi OAuth credentials from KIMI_CODE_HOME and rejects expired access", async () => {
    const config = {
      default_model: "main",
      models: { main: { provider: "kimi", model: "kimi-for-coding" } },
      providers: {
        kimi: {
          type: "kimi",
          base_url: "https://api.example.test",
          oauth: { storage: "file", key: "oauth/kimi-code" },
        },
      },
    }
    const files = {
      "/kimi/config.toml": config,
      "/kimi/credentials/kimi-code.json": { access_token: SECRET, refresh_token: SECRET, expires_at: NOW / 1_000 + 60 },
    }
    const overrides = { env: { KIMI_CODE_HOME: "/kimi" } }
    expect((await availability("kimi", files, overrides)).readiness).toBe("ready")
    files["/kimi/credentials/kimi-code.json"].expires_at = NOW / 1_000 - 1
    expect((await availability("kimi", files, overrides)).readiness).toBe("unauthenticated")
  })

  it.each(["grok", "antigravity"] as const)("does not invent native status commands for %s", async (agent) => {
    const probe = vi.fn()
    expect((await availability(agent, {}, { probe })).readiness).toBe("unknown")
    expect(probe).not.toHaveBeenCalled()
  })

  it.each(["claude", "codex", "cursor"] as const)(
    "uses only advertised read-only native status for %s",
    async (agent) => {
      const result =
        agent === "claude"
          ? {
              exitCode: 0,
              stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: SECRET }),
              stderr: "",
            }
          : { exitCode: 0, stdout: "", stderr: `Logged in using an API key - ${SECRET}` }
      const probe = statusProbe(agent, result)
      expect((await availability(agent, {}, { probe })).readiness).toBe("ready")
      expect(probe.mock.calls.map((call) => call[1])).toEqual(
        agent === "cursor"
          ? [["--help"], ["status"]]
          : [
              ["--help"],
              [agent === "claude" ? "auth" : "login", "--help"],
              [agent === "claude" ? "auth" : "login", "status"],
            ],
      )
    },
  )

  it.each(["claude", "codex", "cursor"] as const)(
    "distinguishes unauthenticated native %s from probe failures",
    async (agent) => {
      const status =
        agent === "claude"
          ? { exitCode: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "" }
          : { exitCode: 1, stdout: "Not authenticated", stderr: "" }
      expect((await availability(agent, {}, { probe: statusProbe(agent, status) })).readiness).toBe("unauthenticated")
      expect(
        (await availability(agent, {}, { probe: statusProbe(agent, { exitCode: 1, stdout: "", stderr: SECRET }) }))
          .readiness,
      ).toBe("unknown")
    },
  )

  it("uses the same filtered environment for native status probes and real agent sessions", async () => {
    const status = statusProbe("claude", {
      exitCode: 0,
      stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
      stderr: "",
    })
    const source = {
      PATH: "/bin",
      HOME: "/home/test",
      CLAUDE_CONFIG_DIR: "/profile",
      AWS_SECRET_ACCESS_KEY: SECRET,
      UNSAFE_SETTING: SECRET,
    }
    const probe: DiscoveryDeps["probe"] = vi.fn(async (path, args, options) => {
      expect(options.env).toEqual(buildAgentEnv("claude", {}, source))
      expect(options.env.CLAUDE_CONFIG_DIR).toBe("/profile")
      expect(options.env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
      expect(options.env.UNSAFE_SETTING).toBeUndefined()
      return status(path, args)
    })
    expect((await availability("claude", {}, { env: source, probe })).readiness).toBe("ready")
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it("does not run auth commands when installed help does not advertise them", async () => {
    const probe = vi.fn(async () => ({ exitCode: 0, stdout: "Commands:\n  exec Run a prompt", stderr: "" }))
    expect((await availability("codex", {}, { probe })).readiness).toBe("unknown")
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it("requires a known Claude status shape instead of any successful JSON output", async () => {
    for (const auth of [{ loggedIn: true }, { loggedIn: true, authMethod: "none" }, { authMethod: "api_key" }]) {
      expect(
        (
          await availability(
            "claude",
            {},
            { probe: statusProbe("claude", { exitCode: 0, stdout: JSON.stringify(auth), stderr: "" }) },
          )
        ).readiness,
      ).toBe("unknown")
    }
  })

  it("bounds stalled probes and aborts them without disclosing exceptions", async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const probe: DiscoveryDeps["probe"] = vi.fn((_path, _args, options) => {
      signal = options.signal
      expect(options.timeoutMs).toBe(5_000)
      expect(options.maxOutputBytes).toBe(16_384)
      return new Promise<AuthProbeResult>(() => {})
    })
    const pending = availability("codex", {}, { probe })
    await vi.advanceTimersByTimeAsync(5_001)
    expect((await pending).readiness).toBe("unknown")
    expect(signal?.aborted).toBe(true)
  })

  it("bounds probe output and hides thrown subprocess errors", async () => {
    const huge = vi.fn(async () => ({ exitCode: 0, stdout: SECRET.repeat(1_000), stderr: "" }))
    expect((await availability("codex", {}, { probe: huge })).readiness).toBe("unknown")
    const failing = vi.fn(async () => {
      throw new Error(SECRET)
    })
    expect((await availability("codex", {}, { probe: failing })).readiness).toBe("unknown")
  })
})
