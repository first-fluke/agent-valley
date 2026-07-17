/**
 * doctor-config-checks.test.ts — Unit tests for `av doctor`'s config,
 * tunnel, webhook-secret checks, and the top-level orchestration
 * (runDoctorChecks / computeExitCode / summarize). Every dependency is a
 * fake `DoctorDeps` — no test here touches the real filesystem, PATH, or
 * spawns a real agent CLI / sandbox binary.
 */

import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { AGENT_TYPES, type DoctorDeps } from "../doctor-checks"
import {
  checkConfig,
  checkTunnel,
  checkWebhookSecret,
  computeExitCode,
  resolveConfiguredAgentType,
  resolveConfiguredTrackerKind,
  runDoctorChecks,
  summarize,
} from "../doctor-config-checks"

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

// ── checkTunnel ──────────────────────────────────────────────────────────────

describe("checkTunnel", () => {
  it("provider none: passes without checking any binary", () => {
    const deps = makeDeps({ resolveBinary: vi.fn() })
    const result = checkTunnel({ tunnel: { provider: "none" } }, deps)
    expect(result.status).toBe("pass")
    expect(deps.resolveBinary).not.toHaveBeenCalled()
  })

  it("cloudflare quick mode: passes when cloudflared is on PATH", () => {
    const deps = makeDeps({ resolveBinary: (name) => (name === "cloudflared" ? "/usr/bin/cloudflared" : null) })
    const result = checkTunnel({ tunnel: { provider: "cloudflare" } }, deps)
    expect(result.status).toBe("pass")
  })

  it("cloudflare: fails when cloudflared is missing", () => {
    const deps = makeDeps({ resolveBinary: () => null })
    const result = checkTunnel({ tunnel: { provider: "cloudflare" } }, deps)
    expect(result.status).toBe("fail")
    expect(result.critical).toBe(false)
    expect(result.fix).toContain("cloudflared")
  })

  it("cloudflare named mode: fails when cert.pem is missing", () => {
    const deps = makeDeps({ resolveBinary: () => "/usr/bin/cloudflared", existsSync: () => false })
    const result = checkTunnel(
      { tunnel: { provider: "cloudflare", cloudflare: { mode: "named", name: "prod" } } },
      deps,
    )
    expect(result.status).toBe("fail")
    expect(result.fix).toContain("cloudflared tunnel login")
  })

  it("cloudflare named mode: passes when cert.pem is present", () => {
    const deps = makeDeps({
      resolveBinary: () => "/usr/bin/cloudflared",
      existsSync: (p) => p === join("/home/user", ".cloudflared", "cert.pem"),
    })
    const result = checkTunnel(
      { tunnel: { provider: "cloudflare", cloudflare: { mode: "named", name: "prod" } } },
      deps,
    )
    expect(result.status).toBe("pass")
  })

  it("ngrok (default provider): fails when ngrok is missing from PATH", () => {
    const deps = makeDeps({ resolveBinary: () => null })
    const result = checkTunnel(null, deps)
    expect(result.status).toBe("fail")
    expect(result.fix).toContain("brew install ngrok")
  })

  it("ngrok: passes immediately when NGROK_AUTHTOKEN env var is set", () => {
    const deps = makeDeps({
      resolveBinary: () => "/usr/local/bin/ngrok",
      env: { NGROK_AUTHTOKEN: "tok" } as unknown as NodeJS.ProcessEnv,
    })
    const result = checkTunnel(null, deps)
    expect(result.status).toBe("pass")
    expect(result.message).toContain("NGROK_AUTHTOKEN")
  })

  it("ngrok: warns when no config file and no env token are present", () => {
    const deps = makeDeps({ resolveBinary: () => "/usr/local/bin/ngrok", existsSync: () => false })
    const result = checkTunnel(null, deps)
    expect(result.status).toBe("warn")
    expect(result.fix).toContain("ngrok config add-authtoken")
  })

  it("ngrok: warns when config file exists but has no authtoken key", () => {
    const deps = makeDeps({
      resolveBinary: () => "/usr/local/bin/ngrok",
      existsSync: () => true,
      readFileSync: () => "some_other_key: 1",
    })
    const result = checkTunnel(null, deps)
    expect(result.status).toBe("warn")
  })

  it("ngrok: reports unknown when config file exists but is unreadable", () => {
    const deps = makeDeps({
      resolveBinary: () => "/usr/local/bin/ngrok",
      existsSync: () => true,
      readFileSync: () => {
        throw new Error("EACCES")
      },
    })
    const result = checkTunnel(null, deps)
    expect(result.status).toBe("unknown")
  })

  it("ngrok: passes when config file exists and contains an authtoken", () => {
    const deps = makeDeps({
      resolveBinary: () => "/usr/local/bin/ngrok",
      existsSync: () => true,
      readFileSync: () => "authtoken: abc123",
    })
    const result = checkTunnel(null, deps)
    expect(result.status).toBe("pass")
  })

  it("no result is ever critical (tunnel never blocks the exit code)", () => {
    const deps = makeDeps({ resolveBinary: () => null })
    expect(checkTunnel(null, deps).critical).toBe(false)
    expect(checkTunnel({ tunnel: { provider: "cloudflare" } }, deps).critical).toBe(false)
  })
})

// ── checkConfig ──────────────────────────────────────────────────────────────

describe("checkConfig", () => {
  it("passes both when global and project config load successfully", () => {
    const deps = makeDeps({
      loadGlobalConfig: () => ({ agent: { type: "claude" } }),
      loadProjectConfig: () => ({ agent: { type: "codex" } }),
    })
    const { results, project, global } = checkConfig(deps)
    expect(results.find((r) => r.id === "config.global")?.status).toBe("pass")
    expect(results.find((r) => r.id === "config.project")?.status).toBe("pass")
    expect(project?.agent?.type).toBe("codex")
    expect(global?.agent?.type).toBe("claude")
  })

  it("warns (non-critical) when global settings.yaml is missing", () => {
    const deps = makeDeps({ loadGlobalConfig: () => null, loadProjectConfig: () => ({}) })
    const result = checkConfig(deps).results.find((r) => r.id === "config.global")
    expect(result?.status).toBe("warn")
    expect(result?.critical).toBe(false)
    expect(result?.fix).toContain("av setup")
  })

  it("fails (critical) with the loader's own message when global config validation throws", () => {
    const deps = makeDeps({
      loadGlobalConfig: () => {
        throw new Error("Global config validation failed: agent.type invalid")
      },
      loadProjectConfig: () => ({}),
    })
    const result = checkConfig(deps).results.find((r) => r.id === "config.global")
    expect(result?.status).toBe("fail")
    expect(result?.critical).toBe(true)
    expect(result?.message).toContain("agent.type invalid")
  })

  it("fails (critical) when valley.yaml is missing", () => {
    const deps = makeDeps({ loadProjectConfig: () => null })
    const result = checkConfig(deps).results.find((r) => r.id === "config.project")
    expect(result?.status).toBe("fail")
    expect(result?.critical).toBe(true)
    expect(result?.fix).toContain("av setup")
  })

  it("fails (critical) with the loader's own message when project config validation throws", () => {
    const deps = makeDeps({
      loadProjectConfig: () => {
        throw new Error("Project config validation failed: workspace.root missing")
      },
    })
    const result = checkConfig(deps).results.find((r) => r.id === "config.project")
    expect(result?.status).toBe("fail")
    expect(result?.message).toContain("workspace.root missing")
  })
})

// ── resolve helpers ──────────────────────────────────────────────────────────

describe("resolveConfiguredAgentType", () => {
  it("prefers project over global, defaults to claude", () => {
    expect(resolveConfiguredAgentType({ agent: { type: "codex" } }, { agent: { type: "claude" } })).toBe("codex")
    expect(resolveConfiguredAgentType(null, { agent: { type: "grok" } })).toBe("grok")
    expect(resolveConfiguredAgentType(null, null)).toBe("claude")
  })
})

describe("resolveConfiguredTrackerKind", () => {
  it("uses explicit tracker.kind first", () => {
    expect(resolveConfiguredTrackerKind({ tracker: { kind: "github" } })).toBe("github")
  })

  it("infers github when only a github block is present", () => {
    expect(resolveConfiguredTrackerKind({ github: { owner: "x", repo: "y" } })).toBe("github")
  })

  it("defaults to linear", () => {
    expect(resolveConfiguredTrackerKind(null)).toBe("linear")
    expect(resolveConfiguredTrackerKind({ linear: { team_id: "T" } })).toBe("linear")
  })
})

// ── checkWebhookSecret ───────────────────────────────────────────────────────

describe("checkWebhookSecret", () => {
  it("linear: passes when webhook_secret is set", () => {
    const result = checkWebhookSecret({ linear: { webhook_secret: "shh" } })
    expect(result.status).toBe("pass")
  })

  it("linear: fails (non-critical) with a fix when webhook_secret is missing", () => {
    const result = checkWebhookSecret(null)
    expect(result.status).toBe("fail")
    expect(result.critical).toBe(false)
    expect(result.fix).toContain("linear.webhook_secret")
  })

  it("github: passes when webhook_secret is set", () => {
    const result = checkWebhookSecret({ tracker: { kind: "github" }, github: { webhook_secret: "shh" } })
    expect(result.status).toBe("pass")
  })

  it("github: fails with a fix when webhook_secret is missing", () => {
    const result = checkWebhookSecret({ tracker: { kind: "github" } })
    expect(result.status).toBe("fail")
    expect(result.fix).toContain("github.webhook_secret")
  })

  it("never prints the secret value itself", () => {
    const result = checkWebhookSecret({ linear: { webhook_secret: "super-secret-value" } })
    expect(result.message).not.toContain("super-secret-value")
    expect(result.fix ?? "").not.toContain("super-secret-value")
  })
})

// ── runDoctorChecks / computeExitCode / summarize ───────────────────────────

describe("runDoctorChecks", () => {
  it("checks only the configured agent by default", async () => {
    const deps = makeDeps({
      loadProjectConfig: () => ({ agent: { type: "grok" } }),
      resolveBinary: () => null,
    })
    const results = await runDoctorChecks(deps)
    const agentIds = results.filter((r) => r.id.startsWith("agent.")).map((r) => r.id)
    expect(agentIds).toEqual(["agent.grok.installed", "agent.grok.auth"])
  })

  it("checks all 7 agents when allAgents is true", async () => {
    const deps = makeDeps({ loadProjectConfig: () => ({ agent: { type: "claude" } }), resolveBinary: () => null })
    const results = await runDoctorChecks(deps, { allAgents: true })
    const installed = results.filter((r) => r.id.endsWith(".installed"))
    expect(installed).toHaveLength(AGENT_TYPES.length)
  })

  it("marks only the configured agent's install failure as critical under --all", async () => {
    const deps = makeDeps({ loadProjectConfig: () => ({ agent: { type: "claude" } }), resolveBinary: () => null })
    const results = await runDoctorChecks(deps, { allAgents: true })
    expect(results.find((r) => r.id === "agent.claude.installed")?.critical).toBe(true)
    expect(results.find((r) => r.id === "agent.codex.installed")?.critical).toBe(false)
  })

  it("includes a resolved-config summary row", async () => {
    const deps = makeDeps({ loadProjectConfig: () => ({ tracker: { kind: "github" }, agent: { type: "codex" } }) })
    const results = await runDoctorChecks(deps)
    const resolved = results.find((r) => r.id === "config.resolved")
    expect(resolved?.message).toBe("tracker: github, agent: codex")
  })
})

describe("computeExitCode", () => {
  it("is 0 when no critical failure is present", () => {
    expect(computeExitCode([{ id: "a", name: "a", status: "warn", message: "", critical: false }])).toBe(0)
    expect(computeExitCode([{ id: "a", name: "a", status: "fail", message: "", critical: false }])).toBe(0)
  })

  it("is 1 when any critical check has status fail", () => {
    expect(computeExitCode([{ id: "a", name: "a", status: "fail", message: "", critical: true }])).toBe(1)
  })

  it("ignores critical checks that are not failing", () => {
    expect(computeExitCode([{ id: "a", name: "a", status: "pass", message: "", critical: true }])).toBe(0)
  })
})

describe("summarize", () => {
  it("counts only status === pass toward passed", () => {
    const results = [
      { id: "a", name: "a", status: "pass" as const, message: "", critical: false },
      { id: "b", name: "b", status: "fail" as const, message: "", critical: false },
      { id: "c", name: "c", status: "warn" as const, message: "", critical: false },
    ]
    expect(summarize(results)).toEqual({ passed: 1, total: 3 })
  })
})
