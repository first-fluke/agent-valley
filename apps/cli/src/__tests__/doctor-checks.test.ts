/**
 * doctor-checks.test.ts — Unit tests for the pure `av doctor` agent-CLI
 * and sandbox check functions. Every dependency (filesystem, PATH
 * resolver, sandbox availability) is a fake passed through `DoctorDeps` —
 * no test here touches the real filesystem, PATH, or spawns a real
 * agent CLI / sandbox binary.
 *
 * Config, tunnel, webhook-secret, and orchestration checks are tested in
 * doctor-config-checks.test.ts (mirrors the doctor-checks.ts /
 * doctor-config-checks.ts split, kept to stay under the 500-line file
 * limit).
 */

import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  AGENT_TYPES,
  checkAgentAuthenticated,
  checkAgentInstalled,
  checkSandbox,
  type DoctorDeps,
} from "../doctor-checks"

function makeDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    cwd: "/project",
    home: "/home/user",
    platform: "darwin",
    env: {} as NodeJS.ProcessEnv,
    existsSync: () => false,
    readFileSync: () => "",
    resolveBinary: () => null,
    isSandboxExecAvailable: async () => false,
    isBwrapAvailable: async () => false,
    resolveGlobalConfigPath: () => "/home/user/.config/agent-valley/settings.yaml",
    loadGlobalConfig: () => null,
    loadProjectConfig: () => null,
    ...overrides,
  }
}

// ── checkAgentInstalled ──────────────────────────────────────────────────────

describe("checkAgentInstalled", () => {
  it("passes when the binary resolves on PATH", () => {
    const deps = makeDeps({ resolveBinary: (name) => (name === "claude" ? "/usr/local/bin/claude" : null) })
    const result = checkAgentInstalled("claude", deps, true)
    expect(result.status).toBe("pass")
    expect(result.message).toContain("/usr/local/bin/claude")
    expect(result.fix).toBeUndefined()
  })

  it("fails with an install hint when the binary is missing, critical when configured", () => {
    const deps = makeDeps({ resolveBinary: () => null })
    const result = checkAgentInstalled("codex", deps, true)
    expect(result.status).toBe("fail")
    expect(result.critical).toBe(true)
    expect(result.fix).toContain("npm install -g @openai/codex")
  })

  it("is non-critical when checking a non-configured agent under --all", () => {
    const deps = makeDeps({ resolveBinary: () => null })
    const result = checkAgentInstalled("grok", deps, false)
    expect(result.status).toBe("fail")
    expect(result.critical).toBe(false)
  })

  it("maps every agent type to a distinct binary + install hint", () => {
    for (const agent of AGENT_TYPES) {
      const deps = makeDeps({ resolveBinary: () => null })
      const result = checkAgentInstalled(agent, deps, false)
      expect(result.fix).toBeTruthy()
    }
  })
})

// ── checkAgentAuthenticated ──────────────────────────────────────────────────

describe("checkAgentAuthenticated", () => {
  it("claude: passes when ~/.claude exists", () => {
    const deps = makeDeps({ existsSync: (p) => p === join("/home/user", ".claude") })
    const result = checkAgentAuthenticated("claude", deps)
    expect(result.status).toBe("pass")
  })

  it("claude: fails with a login hint when ~/.claude is missing", () => {
    const deps = makeDeps({ existsSync: () => false })
    const result = checkAgentAuthenticated("claude", deps)
    expect(result.status).toBe("fail")
    expect(result.fix).toContain("claude")
  })

  it("codex: passes when ~/.codex exists", () => {
    const deps = makeDeps({ existsSync: (p) => p === join("/home/user", ".codex") })
    expect(checkAgentAuthenticated("codex", deps).status).toBe("pass")
  })

  it("grok: passes when ~/.grok/config.toml exists", () => {
    const deps = makeDeps({ existsSync: (p) => p === join("/home/user", ".grok", "config.toml") })
    expect(checkAgentAuthenticated("grok", deps).status).toBe("pass")
  })

  it("kimi: passes when config.toml exists and contains default_model", () => {
    const deps = makeDeps({
      existsSync: (p) => p === join("/home/user", ".kimi-code", "config.toml"),
      readFileSync: () => 'default_model = "kimi-k2"',
    })
    expect(checkAgentAuthenticated("kimi", deps).status).toBe("pass")
  })

  it("kimi: warns when config.toml exists but has no default_model", () => {
    const deps = makeDeps({
      existsSync: (p) => p === join("/home/user", ".kimi-code", "config.toml"),
      readFileSync: () => "some_other_key = 1",
    })
    expect(checkAgentAuthenticated("kimi", deps).status).toBe("warn")
  })

  it("kimi: reports unknown when config.toml exists but is unreadable", () => {
    const deps = makeDeps({
      existsSync: (p) => p === join("/home/user", ".kimi-code", "config.toml"),
      readFileSync: () => {
        throw new Error("EACCES")
      },
    })
    expect(checkAgentAuthenticated("kimi", deps).status).toBe("unknown")
  })

  it("kimi: fails when config.toml is missing", () => {
    const deps = makeDeps({ existsSync: () => false })
    expect(checkAgentAuthenticated("kimi", deps).status).toBe("fail")
  })

  it("opencode: passes when auth.json exists", () => {
    const deps = makeDeps({ existsSync: (p) => p === join("/home/user", ".local", "share", "opencode", "auth.json") })
    expect(checkAgentAuthenticated("opencode", deps).status).toBe("pass")
  })

  it("antigravity and cursor: report unknown rather than guessing", () => {
    const deps = makeDeps()
    expect(checkAgentAuthenticated("antigravity", deps).status).toBe("unknown")
    expect(checkAgentAuthenticated("cursor", deps).status).toBe("unknown")
    expect(checkAgentAuthenticated("antigravity", deps).message).toContain("unknown")
  })

  it("unknown-status results are never marked critical", () => {
    const deps = makeDeps()
    expect(checkAgentAuthenticated("cursor", deps).critical).toBe(false)
  })
})

// ── checkSandbox ─────────────────────────────────────────────────────────────

describe("checkSandbox", () => {
  it("darwin: passes when sandbox-exec is available", async () => {
    const deps = makeDeps({ platform: "darwin", isSandboxExecAvailable: async () => true })
    const result = await checkSandbox(deps)
    expect(result.status).toBe("pass")
    expect(result.critical).toBe(false)
  })

  it("darwin: fails (critical) with an actionable message when sandbox-exec is missing", async () => {
    const deps = makeDeps({ platform: "darwin", isSandboxExecAvailable: async () => false })
    const result = await checkSandbox(deps)
    expect(result.status).toBe("fail")
    expect(result.critical).toBe(true)
    expect(result.fix).toContain("sandbox-exec")
  })

  it("linux: passes when bwrap is available", async () => {
    const deps = makeDeps({ platform: "linux", isBwrapAvailable: async () => true })
    const result = await checkSandbox(deps)
    expect(result.status).toBe("pass")
  })

  it("linux: fails (critical) with an apt-get hint when bwrap is missing", async () => {
    const deps = makeDeps({ platform: "linux", isBwrapAvailable: async () => false })
    const result = await checkSandbox(deps)
    expect(result.status).toBe("fail")
    expect(result.critical).toBe(true)
    expect(result.fix).toContain("apt-get install bubblewrap")
    expect(result.fix).toContain("SYMPHONY_ALLOW_UNSANDBOXED")
  })

  it("unsupported platform: fails (critical)", async () => {
    const deps = makeDeps({ platform: "win32" })
    const result = await checkSandbox(deps)
    expect(result.status).toBe("fail")
    expect(result.critical).toBe(true)
    expect(result.message).toContain("win32")
  })
})
