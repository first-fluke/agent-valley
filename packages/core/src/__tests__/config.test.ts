/**
 * YAML Config Loader tests — loadConfig(), merge priority, validation errors.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { loadConfig, loadGlobalConfig, loadProjectConfig } from "../config/yaml-loader.ts"

// ── Helpers ─────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `av-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeYaml(dir: string, filename: string, content: string): string {
  const path = join(dir, filename)
  writeFileSync(path, content, "utf-8")
  return path
}

const VALID_GLOBAL = `
linear:
  api_key: lin_api_test123

agent:
  type: claude
  timeout: 3600
  max_retries: 3
  retry_delay: 60

logging:
  level: info
  format: json

server:
  port: 9741
`

const VALID_PROJECT = `
linear:
  team_id: ACR
  team_uuid: uuid-team-123
  webhook_secret: whsec_test123
  workflow_states:
    todo: state-todo-uuid
    in_progress: state-ip-uuid
    done: state-done-uuid
    cancelled: state-cancelled-uuid

workspace:
  root: /tmp/workspaces

delivery:
  mode: merge

prompt: |
  You are working on {{issue.identifier}}: {{issue.title}}.
  {{issue.description}}
  Path: {{workspace_path}}
`

// ── loadGlobalConfig ────────────────────────────────────────────────

describe("loadGlobalConfig", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("returns null when file does not exist", () => {
    const result = loadGlobalConfig(join(tempDir, "nonexistent.yaml"))
    expect(result).toBeNull()
  })

  test("returns null for empty file", () => {
    writeYaml(tempDir, "settings.yaml", "")
    expect(loadGlobalConfig(join(tempDir, "settings.yaml"))).toBeNull()
  })

  test("parses valid global config", () => {
    const path = writeYaml(tempDir, "settings.yaml", VALID_GLOBAL)
    const result = loadGlobalConfig(path)

    expect(result).not.toBeNull()
    expect(result?.linear?.api_key).toBe("lin_api_test123")
    expect(result?.agent?.type).toBe("claude")
    expect(result?.agent?.timeout).toBe(3600)
    expect(result?.logging?.level).toBe("info")
    expect(result?.server?.port).toBe(9741)
  })

  test("throws on unknown fields (strict mode)", () => {
    writeYaml(
      tempDir,
      "settings.yaml",
      `
linear:
  api_key: test
unknown_field: value
`,
    )
    expect(() => loadGlobalConfig(join(tempDir, "settings.yaml"))).toThrow("Global config validation failed")
  })

  test("throws on invalid YAML syntax", () => {
    writeYaml(
      tempDir,
      "settings.yaml",
      `
linear:
  api_key: test
  bad_indent:
 wrong
`,
    )
    expect(() => loadGlobalConfig(join(tempDir, "settings.yaml"))).toThrow("Failed to parse")
  })

  test("throws on invalid agent.type enum", () => {
    writeYaml(
      tempDir,
      "settings.yaml",
      `
agent:
  type: invalid_agent
`,
    )
    expect(() => loadGlobalConfig(join(tempDir, "settings.yaml"))).toThrow("Global config validation failed")
  })
})

// ── loadProjectConfig ───────────────────────────────────────────────

describe("loadProjectConfig", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("returns null when valley.yaml does not exist", () => {
    const result = loadProjectConfig(tempDir)
    expect(result).toBeNull()
  })

  test("parses valid project config", () => {
    writeYaml(tempDir, "valley.yaml", VALID_PROJECT)
    const result = loadProjectConfig(tempDir)

    expect(result).not.toBeNull()
    expect(result?.linear?.team_id).toBe("ACR")
    expect(result?.linear?.workflow_states?.todo).toBe("state-todo-uuid")
    expect(result?.workspace?.root).toBe("/tmp/workspaces")
    expect(result?.prompt).toContain("{{issue.identifier}}")
  })

  test("parses routing rules", () => {
    writeYaml(
      tempDir,
      "valley.yaml",
      `
linear:
  team_id: ACR
  team_uuid: uuid
  webhook_secret: whsec
  workflow_states:
    todo: s1
    in_progress: s2
    done: s3
    cancelled: s4
workspace:
  root: /tmp/ws
prompt: test prompt
routing:
  rules:
    - label: "scope:backend"
      workspace_root: /tmp/backend
      agent_type: codex
      delivery_mode: pr
    - label: "scope:frontend"
      workspace_root: /tmp/frontend
`,
    )
    const result = loadProjectConfig(tempDir)

    expect(result?.routing?.rules).toHaveLength(2)
    expect(result?.routing?.rules?.[0]?.label).toBe("scope:backend")
    expect(result?.routing?.rules?.[0]?.agent_type).toBe("codex")
    expect(result?.routing?.rules?.[1]?.agent_type).toBeUndefined()
  })

  test("parses scoring routes", () => {
    writeYaml(
      tempDir,
      "valley.yaml",
      `
linear:
  team_id: T
  team_uuid: U
  webhook_secret: W
  workflow_states:
    todo: s1
    in_progress: s2
    done: s3
    cancelled: s4
workspace:
  root: /tmp/ws
prompt: test
scoring:
  model: haiku
  routes:
    easy:
      min: 1
      max: 3
      agent: gemini
    medium:
      min: 4
      max: 7
      agent: codex
    hard:
      min: 8
      max: 10
      agent: claude
`,
    )
    const result = loadProjectConfig(tempDir)

    expect(result?.scoring?.model).toBe("haiku")
    expect(result?.scoring?.routes?.easy.agent).toBe("gemini")
    expect(result?.scoring?.routes?.hard.max).toBe(10)
  })

  test("rejects routing rule with relative workspace_root", () => {
    writeYaml(
      tempDir,
      "valley.yaml",
      `
linear:
  team_id: T
  team_uuid: U
  webhook_secret: W
  workflow_states:
    todo: s1
    in_progress: s2
    done: s3
    cancelled: s4
workspace:
  root: /tmp/ws
prompt: test
routing:
  rules:
    - label: bad
      workspace_root: relative/path
`,
    )
    expect(() => loadProjectConfig(tempDir)).toThrow("Project config validation failed")
  })

  test("rejects overlapping score tiers", () => {
    writeYaml(
      tempDir,
      "valley.yaml",
      `
linear:
  team_id: T
  team_uuid: U
  webhook_secret: W
  workflow_states:
    todo: s1
    in_progress: s2
    done: s3
    cancelled: s4
workspace:
  root: /tmp/ws
prompt: test
scoring:
  routes:
    easy:
      min: 1
      max: 5
      agent: gemini
    medium:
      min: 4
      max: 7
      agent: codex
    hard:
      min: 8
      max: 10
      agent: claude
`,
    )
    expect(() => loadProjectConfig(tempDir)).toThrow("Project config validation failed")
  })
})

// ── loadConfig (merge) ──────────────────────────────────────────────

describe("loadConfig", () => {
  let globalDir: string
  let projectDir: string
  let exitSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    globalDir = makeTempDir()
    projectDir = makeTempDir()
    exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => {
      throw new Error(`process.exit(${_code})`)
    })
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    rmSync(globalDir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
    exitSpy.mockRestore()
    errorSpy.mockRestore()
  })

  test("valid global + project produces correct Config", () => {
    const globalPath = writeYaml(globalDir, "settings.yaml", VALID_GLOBAL)
    writeYaml(projectDir, "valley.yaml", VALID_PROJECT)

    const config = loadConfig(projectDir, globalPath)

    expect(config.linearApiKey).toBe("lin_api_test123")
    expect(config.linearTeamId).toBe("ACR")
    expect(config.linearTeamUuid).toBe("uuid-team-123")
    expect(config.linearWebhookSecret).toBe("whsec_test123")
    expect(config.workflowStates.todo).toBe("state-todo-uuid")
    expect(config.workflowStates.inProgress).toBe("state-ip-uuid")
    expect(config.workflowStates.done).toBe("state-done-uuid")
    expect(config.workflowStates.cancelled).toBe("state-cancelled-uuid")
    expect(config.workspaceRoot).toBe("/tmp/workspaces")
    expect(config.agentType).toBe("claude")
    expect(config.logLevel).toBe("info")
    expect(config.serverPort).toBe(9741)
    expect(config.deliveryMode).toBe("merge")
    expect(config.promptTemplate).toContain("{{issue.identifier}}")
  })

  test("project overrides global values", () => {
    const globalPath = writeYaml(
      globalDir,
      "settings.yaml",
      `
linear:
  api_key: global_key
agent:
  type: claude
  timeout: 1800
logging:
  level: debug
server:
  port: 8000
`,
    )
    writeYaml(
      projectDir,
      "valley.yaml",
      `
linear:
  api_key: project_key
  team_id: PROJ
  team_uuid: uuid-proj
  webhook_secret: whsec_proj
  workflow_states:
    todo: s1
    in_progress: s2
    done: s3
    cancelled: s4
workspace:
  root: /tmp/project-ws
agent:
  type: codex
  timeout: 7200
logging:
  level: warn
server:
  port: 3000
prompt: project prompt
`,
    )
    const config = loadConfig(projectDir, globalPath)

    expect(config.linearApiKey).toBe("project_key")
    expect(config.agentType).toBe("codex")
    expect(config.agentTimeout).toBe(7200)
    expect(config.logLevel).toBe("warn")
    expect(config.serverPort).toBe(3000)
  })

  test("global defaults used when project omits optional fields", () => {
    const globalPath = writeYaml(
      globalDir,
      "settings.yaml",
      `
linear:
  api_key: global_key
agent:
  type: gemini
  timeout: 1800
logging:
  level: debug
  format: text
server:
  port: 8080
`,
    )
    writeYaml(
      projectDir,
      "valley.yaml",
      `
linear:
  team_id: TEAM
  team_uuid: uuid
  webhook_secret: whsec
  workflow_states:
    todo: s1
    in_progress: s2
    done: s3
    cancelled: s4
workspace:
  root: /tmp/ws
prompt: test prompt
`,
    )
    const config = loadConfig(projectDir, globalPath)

    // From global
    expect(config.linearApiKey).toBe("global_key")
    expect(config.agentType).toBe("gemini")
    expect(config.agentTimeout).toBe(1800)
    expect(config.logLevel).toBe("debug")
    expect(config.logFormat).toBe("text")
    expect(config.serverPort).toBe(8080)
  })

  test("hardcoded defaults used when both configs omit optional fields", () => {
    writeYaml(
      globalDir,
      "settings.yaml",
      `
linear:
  api_key: key
`,
    )
    writeYaml(
      projectDir,
      "valley.yaml",
      `
linear:
  team_id: T
  team_uuid: U
  webhook_secret: W
  workflow_states:
    todo: s1
    in_progress: s2
    done: s3
    cancelled: s4
workspace:
  root: /tmp/ws
prompt: test
`,
    )
    const globalPath = join(globalDir, "settings.yaml")
    const config = loadConfig(projectDir, globalPath)

    expect(config.agentType).toBe("claude")
    expect(config.agentTimeout).toBe(3600)
    expect(config.agentMaxRetries).toBe(3)
    expect(config.agentRetryDelay).toBe(60)
    expect(config.logLevel).toBe("info")
    expect(config.logFormat).toBe("json")
    expect(config.deliveryMode).toBe("merge")
    expect(config.serverPort).toBe(9741)
  })

  test("missing valley.yaml exits with actionable error", () => {
    const globalPath = writeYaml(globalDir, "settings.yaml", VALID_GLOBAL)

    expect(() => loadConfig(projectDir, globalPath)).toThrow("process.exit(1)")
    const errorOutput = (errorSpy.mock.calls[0] as string[])[0]
    expect(errorOutput).toContain("valley.yaml not found")
    expect(errorOutput).toContain("av setup")
  })

  test("missing global config is OK (returns null, uses defaults)", () => {
    writeYaml(
      projectDir,
      "valley.yaml",
      `
linear:
  api_key: project_key
  team_id: T
  team_uuid: U
  webhook_secret: W
  workflow_states:
    todo: s1
    in_progress: s2
    done: s3
    cancelled: s4
workspace:
  root: /tmp/ws
prompt: test prompt
`,
    )
    const nonexistentGlobal = join(globalDir, "nonexistent.yaml")
    const config = loadConfig(projectDir, nonexistentGlobal)

    expect(config.linearApiKey).toBe("project_key")
    expect(config.agentType).toBe("claude") // hardcoded default
  })

  test("missing required fields exits with all errors listed", () => {
    writeYaml(globalDir, "settings.yaml", "")
    writeYaml(
      projectDir,
      "valley.yaml",
      `
workspace:
  root: /tmp/ws
prompt: test
`,
    )
    const globalPath = join(globalDir, "settings.yaml")

    expect(() => loadConfig(projectDir, globalPath)).toThrow("process.exit(1)")
    const errorOutput = (errorSpy.mock.calls[0] as string[])[0]
    expect(errorOutput).toContain("linear.api_key")
    expect(errorOutput).toContain("linear.team_id")
    expect(errorOutput).toContain("linear.webhook_secret")
  })

  test("non-absolute workspace.root fails with fix message", () => {
    const globalPath = writeYaml(globalDir, "settings.yaml", VALID_GLOBAL)
    writeYaml(
      projectDir,
      "valley.yaml",
      `
linear:
  team_id: T
  team_uuid: U
  webhook_secret: W
  workflow_states:
    todo: s1
    in_progress: s2
    done: s3
    cancelled: s4
workspace:
  root: relative/path
prompt: test
`,
    )
    expect(() => loadConfig(projectDir, globalPath)).toThrow("process.exit(1)")
    const errorOutput = (errorSpy.mock.calls[0] as string[])[0]
    expect(errorOutput).toContain("workspace")
    expect(errorOutput).toContain("absolute path")
  })

  test("routing rules are converted to camelCase in merged config", () => {
    const globalPath = writeYaml(globalDir, "settings.yaml", VALID_GLOBAL)
    writeYaml(
      projectDir,
      "valley.yaml",
      `
linear:
  team_id: T
  team_uuid: U
  webhook_secret: W
  workflow_states:
    todo: s1
    in_progress: s2
    done: s3
    cancelled: s4
workspace:
  root: /tmp/ws
prompt: test
routing:
  rules:
    - label: "scope:api"
      workspace_root: /tmp/api
      agent_type: codex
      delivery_mode: pr
`,
    )
    const config = loadConfig(projectDir, globalPath)

    expect(config.routingRules).toHaveLength(1)
    expect(config.routingRules[0]?.label).toBe("scope:api")
    expect(config.routingRules[0]?.workspaceRoot).toBe("/tmp/api")
    expect(config.routingRules[0]?.agentType).toBe("codex")
    expect(config.routingRules[0]?.deliveryMode).toBe("pr")
  })

  test("empty routing rules defaults to empty array", () => {
    const globalPath = writeYaml(globalDir, "settings.yaml", VALID_GLOBAL)
    writeYaml(projectDir, "valley.yaml", VALID_PROJECT)
    const config = loadConfig(projectDir, globalPath)

    expect(config.routingRules).toEqual([])
  })

  test("team mode fields merge from global", () => {
    const globalPath = writeYaml(
      globalDir,
      "settings.yaml",
      `
linear:
  api_key: key
team:
  supabase_url: https://xxx.supabase.co
  supabase_anon_key: eyJxxx
  id: team-1
  display_name: tester
`,
    )
    writeYaml(
      projectDir,
      "valley.yaml",
      `
linear:
  team_id: T
  team_uuid: U
  webhook_secret: W
  workflow_states:
    todo: s1
    in_progress: s2
    done: s3
    cancelled: s4
workspace:
  root: /tmp/ws
prompt: test
`,
    )
    const config = loadConfig(projectDir, globalPath)

    expect(config.supabaseUrl).toBe("https://xxx.supabase.co")
    expect(config.supabaseAnonKey).toBe("eyJxxx")
    expect(config.teamId).toBe("team-1")
    expect(config.displayName).toBe("tester")
  })

  test("multiline prompt template is preserved", () => {
    const globalPath = writeYaml(globalDir, "settings.yaml", VALID_GLOBAL)
    writeYaml(
      projectDir,
      "valley.yaml",
      `
linear:
  team_id: T
  team_uuid: U
  webhook_secret: W
  workflow_states:
    todo: s1
    in_progress: s2
    done: s3
    cancelled: s4
workspace:
  root: /tmp/ws
prompt: |
  Line 1 of prompt
  Line 2 with {{issue.identifier}}

  Line 4 after blank line
`,
    )
    const config = loadConfig(projectDir, globalPath)

    expect(config.promptTemplate).toContain("Line 1 of prompt")
    expect(config.promptTemplate).toContain("{{issue.identifier}}")
    expect(config.promptTemplate).toContain("Line 4 after blank line")
  })

  test("missing prompt field exits with error", () => {
    const globalPath = writeYaml(globalDir, "settings.yaml", VALID_GLOBAL)
    writeYaml(
      projectDir,
      "valley.yaml",
      `
linear:
  team_id: T
  team_uuid: U
  webhook_secret: W
  workflow_states:
    todo: s1
    in_progress: s2
    done: s3
    cancelled: s4
workspace:
  root: /tmp/ws
`,
    )
    expect(() => loadConfig(projectDir, globalPath)).toThrow("process.exit(1)")
    const errorOutput = (errorSpy.mock.calls[0] as string[])[0]
    expect(errorOutput).toContain("prompt")
  })

  test("XDG_CONFIG_HOME is respected", () => {
    const customXdg = makeTempDir()
    const avDir = join(customXdg, "agent-valley")
    mkdirSync(avDir, { recursive: true })

    const originalXdg = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = customXdg

    try {
      writeYaml(avDir, "settings.yaml", VALID_GLOBAL)
      writeYaml(projectDir, "valley.yaml", VALID_PROJECT)

      // loadConfig without explicit globalConfigPath should use XDG
      const config = loadConfig(projectDir)
      expect(config.linearApiKey).toBe("lin_api_test123")
    } finally {
      if (originalXdg !== undefined) {
        process.env.XDG_CONFIG_HOME = originalXdg
      } else {
        delete process.env.XDG_CONFIG_HOME
      }
      rmSync(customXdg, { recursive: true, force: true })
    }
  })

  test("tunnel defaults to provider=ngrok when the tunnel block is omitted", () => {
    const globalPath = writeYaml(globalDir, "settings.yaml", VALID_GLOBAL)
    writeYaml(projectDir, "valley.yaml", VALID_PROJECT)
    const config = loadConfig(projectDir, globalPath)
    expect(config.tunnel.provider).toBe("ngrok")
    expect(config.tunnel.cloudflare.mode).toBe("quick")
    expect(config.tunnel.cloudflare.name).toBeUndefined()
    expect(config.tunnel.cloudflare.hostname).toBeUndefined()
  })

  test("tunnel cloudflare quick mode parses without name/hostname", () => {
    const globalPath = writeYaml(globalDir, "settings.yaml", VALID_GLOBAL)
    writeYaml(
      projectDir,
      "valley.yaml",
      `
linear:
  team_id: T
  team_uuid: U
  webhook_secret: W
  workflow_states:
    todo: s1
    in_progress: s2
    done: s3
    cancelled: s4
workspace:
  root: /tmp/ws
prompt: test
tunnel:
  provider: cloudflare
  cloudflare:
    mode: quick
`,
    )
    const config = loadConfig(projectDir, globalPath)
    expect(config.tunnel.provider).toBe("cloudflare")
    expect(config.tunnel.cloudflare.mode).toBe("quick")
  })

  test("tunnel cloudflare named mode requires name — error is actionable", () => {
    writeYaml(
      projectDir,
      "valley.yaml",
      `
linear:
  team_id: T
  team_uuid: U
  webhook_secret: W
  workflow_states:
    todo: s1
    in_progress: s2
    done: s3
    cancelled: s4
workspace:
  root: /tmp/ws
prompt: test
tunnel:
  provider: cloudflare
  cloudflare:
    mode: named
`,
    )
    // Fires at loadProjectConfig via superRefine — before the merged
    // validator runs. Message must be actionable.
    try {
      loadProjectConfig(projectDir)
      throw new Error("expected loadProjectConfig to throw")
    } catch (err) {
      const msg = (err as Error).message
      expect(msg).toContain("Project config validation failed")
      expect(msg).toContain("tunnel.cloudflare.name is required")
      expect(msg).toContain("Fix:")
    }
  })

  test("tunnel cloudflare named mode accepted when name is set", () => {
    const globalPath = writeYaml(globalDir, "settings.yaml", VALID_GLOBAL)
    writeYaml(
      projectDir,
      "valley.yaml",
      `
linear:
  team_id: T
  team_uuid: U
  webhook_secret: W
  workflow_states:
    todo: s1
    in_progress: s2
    done: s3
    cancelled: s4
workspace:
  root: /tmp/ws
prompt: test
tunnel:
  provider: cloudflare
  cloudflare:
    mode: named
    name: av-webhook
    hostname: hooks.example.com
`,
    )
    const config = loadConfig(projectDir, globalPath)
    expect(config.tunnel.provider).toBe("cloudflare")
    expect(config.tunnel.cloudflare.mode).toBe("named")
    expect(config.tunnel.cloudflare.name).toBe("av-webhook")
    expect(config.tunnel.cloudflare.hostname).toBe("hooks.example.com")
  })

  test("tunnel provider=none is accepted", () => {
    const globalPath = writeYaml(globalDir, "settings.yaml", VALID_GLOBAL)
    writeYaml(
      projectDir,
      "valley.yaml",
      `
linear:
  team_id: T
  team_uuid: U
  webhook_secret: W
  workflow_states:
    todo: s1
    in_progress: s2
    done: s3
    cancelled: s4
workspace:
  root: /tmp/ws
prompt: test
tunnel:
  provider: none
`,
    )
    const config = loadConfig(projectDir, globalPath)
    expect(config.tunnel.provider).toBe("none")
  })

  test("tunnel provider with invalid enum value fails validation", () => {
    writeYaml(globalDir, "settings.yaml", VALID_GLOBAL)
    writeYaml(
      projectDir,
      "valley.yaml",
      `
linear:
  team_id: T
  team_uuid: U
  webhook_secret: W
  workflow_states:
    todo: s1
    in_progress: s2
    done: s3
    cancelled: s4
workspace:
  root: /tmp/ws
prompt: test
tunnel:
  provider: bogus
`,
    )
    expect(() => loadProjectConfig(projectDir)).toThrow("Project config validation failed")
  })

  test("scoring routes are passed through to merged config", () => {
    const globalPath = writeYaml(globalDir, "settings.yaml", VALID_GLOBAL)
    writeYaml(
      projectDir,
      "valley.yaml",
      `
linear:
  team_id: T
  team_uuid: U
  webhook_secret: W
  workflow_states:
    todo: s1
    in_progress: s2
    done: s3
    cancelled: s4
workspace:
  root: /tmp/ws
prompt: test
scoring:
  model: haiku
  routes:
    easy:
      min: 1
      max: 3
      agent: gemini
    medium:
      min: 4
      max: 7
      agent: codex
    hard:
      min: 8
      max: 10
      agent: claude
`,
    )
    const config = loadConfig(projectDir, globalPath)

    expect(config.scoringModel).toBe("haiku")
    expect(config.scoreRouting?.easy.agent).toBe("gemini")
    expect(config.scoreRouting?.medium.agent).toBe("codex")
    expect(config.scoreRouting?.hard.agent).toBe("claude")
  })
})
