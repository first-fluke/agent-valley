import { describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"
import {
  buildGlobalYaml,
  buildGlobalYamlGithub,
  buildProjectYaml,
  buildProjectYamlGithub,
  DEFAULT_PROMPT,
} from "../../setup/yaml-build"

describe("buildGlobalYaml (linear)", () => {
  it("emits api_key, agent type, logging, server", () => {
    const out = buildGlobalYaml({ apiKey: "lin_api_test123", agentType: "claude", maxParallel: 3 })
    const parsed = parseYaml(out) as Record<string, Record<string, unknown>>
    expect(parsed.linear?.api_key).toBe("lin_api_test123")
    expect(parsed.agent?.type).toBe("claude")
    expect(parsed.logging?.level).toBe("info")
    expect(parsed.server?.port).toBe(9741)
  })
})

describe("buildGlobalYamlGithub", () => {
  it("omits the linear block entirely (no api_key written)", () => {
    const out = buildGlobalYamlGithub({ agentType: "claude", maxParallel: 3 })
    const parsed = parseYaml(out) as Record<string, unknown>
    expect(parsed.linear).toBeUndefined()
    expect((parsed.agent as Record<string, unknown>).type).toBe("claude")
  })

  it("never contains the substring 'api_key'", () => {
    const out = buildGlobalYamlGithub({ agentType: "codex", maxParallel: 1 })
    expect(out).not.toContain("api_key")
  })
})

describe("buildProjectYaml (linear)", () => {
  it("sets tracker.kind to linear and fills all linear fields", () => {
    const out = buildProjectYaml({
      teamKey: "FIR",
      teamUuid: "uuid-1",
      webhookSecret: "lin_wh_sec",
      todoStateId: "t",
      inProgressStateId: "ip",
      doneStateId: "d",
      cancelledStateId: "c",
      workspaceRoot: "/ws",
    })
    const parsed = parseYaml(out) as Record<string, Record<string, unknown>>
    expect(parsed.tracker?.kind).toBe("linear")
    expect(parsed.linear?.team_id).toBe("FIR")
    expect(parsed.linear?.team_uuid).toBe("uuid-1")
    expect(parsed.linear?.webhook_secret).toBe("lin_wh_sec")
    expect(parsed.workspace?.root).toBe("/ws")
    expect(parsed.delivery?.mode).toBe("merge")
    expect(typeof parsed.prompt).toBe("string")
  })
})

describe("buildProjectYaml — tunnel block", () => {
  const base = {
    teamKey: "FIR",
    teamUuid: "uuid-1",
    webhookSecret: "lin_wh_sec",
    todoStateId: "t",
    inProgressStateId: "ip",
    doneStateId: "d",
    cancelledStateId: "c",
    workspaceRoot: "/ws",
  }

  it("omits tunnel block entirely when provider is the ngrok default", () => {
    const out = buildProjectYaml({ ...base, tunnel: { provider: "ngrok" } })
    expect(out).not.toContain("tunnel:")
  })

  it("omits tunnel block when no tunnel is supplied (back-compat)", () => {
    const out = buildProjectYaml(base)
    expect(out).not.toContain("tunnel:")
  })

  it("writes provider: none with a cloudflare stub", () => {
    const out = buildProjectYaml({ ...base, tunnel: { provider: "none" } })
    const parsed = parseYaml(out) as Record<string, Record<string, unknown>>
    expect(parsed.tunnel?.provider).toBe("none")
  })

  it("writes cloudflare quick mode without name/hostname", () => {
    const out = buildProjectYaml({
      ...base,
      tunnel: { provider: "cloudflare", cloudflare: { mode: "quick" } },
    })
    const parsed = parseYaml(out) as Record<string, Record<string, unknown>>
    expect(parsed.tunnel?.provider).toBe("cloudflare")
    const cf = parsed.tunnel?.cloudflare as Record<string, unknown>
    expect(cf.mode).toBe("quick")
    expect(cf.name).toBeUndefined()
    expect(cf.hostname).toBeUndefined()
  })

  it("writes cloudflare named mode with name and hostname", () => {
    const out = buildProjectYaml({
      ...base,
      tunnel: {
        provider: "cloudflare",
        cloudflare: { mode: "named", name: "av-webhook", hostname: "hooks.example.com" },
      },
    })
    const parsed = parseYaml(out) as Record<string, Record<string, unknown>>
    const cf = parsed.tunnel?.cloudflare as Record<string, unknown>
    expect(cf.mode).toBe("named")
    expect(cf.name).toBe("av-webhook")
    expect(cf.hostname).toBe("hooks.example.com")
  })
})

describe("buildProjectYamlGithub — tunnel block", () => {
  const base = {
    tokenEnv: "GITHUB_TOKEN",
    owner: "first-fluke",
    repo: "agent-valley",
    webhookSecret: "whsec_x",
    labels: { todo: "a", inProgress: "b", done: "c", cancelled: "d" },
    workspaceRoot: "/ws",
  }

  it("serialises cloudflare quick tunnel alongside github config", () => {
    const out = buildProjectYamlGithub({
      ...base,
      tunnel: { provider: "cloudflare", cloudflare: { mode: "quick" } },
    })
    const parsed = parseYaml(out) as Record<string, Record<string, unknown>>
    expect(parsed.tracker?.kind).toBe("github")
    expect(parsed.tunnel?.provider).toBe("cloudflare")
  })
})

describe("buildProjectYamlGithub", () => {
  const base = {
    tokenEnv: "GITHUB_TOKEN",
    owner: "first-fluke",
    repo: "agent-valley",
    webhookSecret: "whsec_abcd1234efgh5678",
    labels: { todo: "valley:todo", inProgress: "valley:wip", done: "valley:done", cancelled: "valley:cancelled" },
    workspaceRoot: "/home/x/workspaces",
  }

  it("sets tracker.kind to github and fills all github fields", () => {
    const out = buildProjectYamlGithub(base)
    const parsed = parseYaml(out) as Record<string, Record<string, unknown>>
    expect(parsed.tracker?.kind).toBe("github")
    expect(parsed.github?.token_env).toBe("GITHUB_TOKEN")
    expect(parsed.github?.owner).toBe("first-fluke")
    expect(parsed.github?.repo).toBe("agent-valley")
    expect(parsed.github?.webhook_secret).toBe("whsec_abcd1234efgh5678")
    const labels = parsed.github?.labels as Record<string, string>
    expect(labels.todo).toBe("valley:todo")
    expect(labels.in_progress).toBe("valley:wip")
    expect(labels.done).toBe("valley:done")
    expect(labels.cancelled).toBe("valley:cancelled")
  })

  it("never contains the raw token value or 'token:' field", () => {
    const out = buildProjectYamlGithub({ ...base, tokenEnv: "MY_ENV" })
    // Only the env var reference — no field named 'token' (without suffix).
    expect(out).not.toMatch(/\btoken:/)
    expect(out).toContain("token_env: MY_ENV")
  })

  it("uses the default prompt when none is given", () => {
    const out = buildProjectYamlGithub(base)
    const parsed = parseYaml(out) as Record<string, unknown>
    expect(parsed.prompt).toBe(DEFAULT_PROMPT)
  })
})
