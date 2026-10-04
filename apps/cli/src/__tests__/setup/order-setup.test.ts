import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { globalConfigSchema } from "@agent-valley/core/config/yaml-loader"
import * as p from "@clack/prompts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parse } from "yaml"
import { detectInviteFromClipboard } from "../../invite"
import { stepAgentType } from "../../setup/agent-step"
import { stepChief } from "../../setup/chief-step"
import { setupEdit } from "../../setup/edit"
import { fastTrackSetup } from "../../setup/fast-track"
import { setup } from "../../setup/index"
import { stepApiKey } from "../../setup/linear-step"
import { stepOma } from "../../setup/oma-step"
import { renderPreview } from "../../setup/preview"
import { resolveContext } from "../../setup/resolve"
import { saveConfig } from "../../setup/save"
import { stepTrackerKind } from "../../setup/tracker-step"
import { BACK, CANCEL } from "../../setup/types"
import { validateOrderWorkspace } from "../../setup/workspace-step"

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
  multiselect: vi.fn(),
  isCancel: (value: unknown) => typeof value === "symbol",
  log: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))
vi.mock("../../invite", () => ({ detectInviteFromClipboard: vi.fn() }))
vi.mock("../../setup/agent-step", () => ({ stepAgentType: vi.fn() }))
vi.mock("../../setup/chief-step", () => ({ stepChief: vi.fn() }))
vi.mock("../../setup/oma-step", () => ({ stepOma: vi.fn() }))
vi.mock("../../setup/tracker-step", () => ({ stepTrackerKind: vi.fn() }))
vi.mock("../../setup/linear-step", () => ({
  stepApiKey: vi.fn(),
  stepTeam: vi.fn(),
  stepWorkflowStates: vi.fn(),
  stepWebhook: vi.fn(),
}))

let originalCwd: string
let originalXdg: string | undefined
let root: string
let repo: string
let settingsPath: string

function createRepository(path: string, committed = true): void {
  mkdirSync(path)
  const options = { cwd: path, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }
  execFileSync("git", ["init", "--quiet"], options)
  if (committed)
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "fixture",
      ],
      options,
    )
}

function writeDefaults(): void {
  mkdirSync(join(root, "config", "agent-valley"), { recursive: true })
  writeFileSync(settingsPath, "agent:\n  type: codex\n  model: saved-chief-model\nserver:\n  port: 9900\n")
}

beforeEach(() => {
  vi.resetAllMocks()
  originalCwd = process.cwd()
  originalXdg = process.env.XDG_CONFIG_HOME
  root = mkdtempSync(join(tmpdir(), "av-order-setup-"))
  repo = join(root, "repo")
  settingsPath = join(root, "config", "agent-valley", "settings.yaml")
  createRepository(repo)
  process.env.XDG_CONFIG_HOME = join(root, "config")
  process.chdir(repo)
  vi.mocked(p.select).mockResolvedValue("code")
  vi.mocked(p.text).mockResolvedValueOnce(repo).mockResolvedValueOnce(" test -s output.md ")
  vi.mocked(p.confirm).mockResolvedValue(true)
  vi.mocked(stepAgentType).mockImplementation(async (context) => {
    context.agentType = "codex"
    context.agentModel = "chosen-chief-model"
    return undefined
  })
  vi.mocked(detectInviteFromClipboard).mockResolvedValue(null)
})

afterEach(() => {
  process.chdir(originalCwd)
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalXdg
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe("standalone order setup", () => {
  it("installs clients in a separately selected repository while keeping their server on the original configuration directory", async () => {
    const selected = join(root, "selected-repository")
    createRepository(selected)
    vi.mocked(p.text).mockReset().mockResolvedValueOnce(selected).mockResolvedValueOnce("test -s output.md")
    await setup()
    expect(parse(readFileSync(join(repo, "av.yaml"), "utf8")).workspace.root).toBe(selected)
    expect(readFileSync(join(selected, ".agents/skills/av/SKILL.md"), "utf8")).toContain("AGENT_VALLEY_MANAGED_RUN")
    expect(JSON.parse(readFileSync(join(selected, ".qwen/settings.json"), "utf8")).mcpServers.av.args).toEqual([
      "mcp",
      "--workspace",
      realpathSync(repo),
    ])
  })

  it("prepares client integration for the new target when editing the workspace", async () => {
    await setup()
    const selected = join(root, "edited-repository")
    createRepository(selected)
    vi.mocked(p.multiselect).mockResolvedValue(["workspaceRoot"])
    vi.mocked(p.text).mockReset().mockResolvedValueOnce(selected)
    await setupEdit()
    expect(parse(readFileSync(join(repo, "av.yaml"), "utf8")).workspace.root).toBe(selected)
    expect(JSON.parse(readFileSync(join(selected, ".mcp.json"), "utf8")).mcpServers.av.args).toEqual([
      "mcp",
      "--workspace",
      realpathSync(repo),
    ])
  })

  it("saves a complete order setup with Chief-designed checks and no verification override", async () => {
    vi.mocked(p.select).mockResolvedValue("chief")
    vi.mocked(p.text).mockReset().mockResolvedValueOnce(repo)
    await setup()
    const project = parse(readFileSync("av.yaml", "utf-8"))
    expect(project).toEqual({ workspace: { root: repo } })
    expect(parse(readFileSync(settingsPath, "utf-8")).actor).toMatchObject({
      type: "codex",
      model: "chosen-chief-model",
    })
    expect(p.text).toHaveBeenCalledOnce()
    expect(p.note).not.toHaveBeenCalledWith(expect.anything(), "Required completion setup")
    const resolved = resolveContext({ trackerKind: "none", workspaceRoot: repo, agentType: "codex" })
    if (!resolved.ok) throw new Error(resolved.error)
    expect(renderPreview(resolved.ctx)).toContain("Chief-designed checks")
    expect(renderPreview(resolved.ctx)).not.toContain("verify.command")
  })

  it("starts without tracker prompts and saves a usable local order configuration", async () => {
    await setup()
    const project = parse(readFileSync("av.yaml", "utf-8"))
    const defaults = parse(readFileSync(settingsPath, "utf-8"))
    expect(project).toEqual({
      workspace: { root: repo },
      verify: { command: "test -s output.md" },
      task: { kind: "code" },
    })
    expect(defaults.actor).toEqual({ type: "codex", model: "chosen-chief-model", max_parallel: 1 })
    expect(defaults.linear).toBeUndefined()
    expect(stepTrackerKind).not.toHaveBeenCalled()
    expect(detectInviteFromClipboard).not.toHaveBeenCalled()
    expect(p.outro).toHaveBeenCalledWith(expect.stringContaining('av order "your goal"'))
    expect(stepOma).toHaveBeenCalledWith(expect.objectContaining({ workspaceRoot: repo }), 3, 5)
    expect(stepChief).toHaveBeenCalledWith(expect.anything(), 4, 5)
    expect(vi.mocked(stepOma).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(stepAgentType).mock.invocationCallOrder[0] as number,
    )
  })

  it("returns to Chief Director selection when OMA requests Back", async () => {
    vi.mocked(stepOma).mockResolvedValueOnce(BACK).mockResolvedValueOnce(undefined)
    await setup()
    expect(stepAgentType).toHaveBeenCalledTimes(2)
    expect(stepOma).toHaveBeenCalledTimes(2)
    expect(existsSync("av.yaml")).toBe(true)
  })

  it("does not save partial configuration when OMA setup is cancelled", async () => {
    vi.mocked(stepOma).mockResolvedValueOnce(CANCEL)
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("cancelled")
    })
    await expect(setup()).rejects.toThrow("cancelled")
    expect(existsSync("av.yaml")).toBe(false)
    expect(existsSync(settingsPath)).toBe(false)
  })

  it("creates av.yaml without importing or replacing valley.yaml", async () => {
    const oldConfig = "workspace:\n  root: /ignored-repository\nverify:\n  command: ignored-check\n"
    writeFileSync("valley.yaml", oldConfig)
    await setup()
    const project = parse(readFileSync("av.yaml", "utf-8"))
    expect(project.workspace.root).toBe(repo)
    expect(project.verify.command).toBe("test -s output.md")
    expect(readFileSync("valley.yaml", "utf-8")).toBe(oldConfig)
    expect(p.confirm).toHaveBeenCalledTimes(1)
    expect(p.confirm).toHaveBeenCalledWith({ message: "Save this configuration?" })
  })

  it("offers the saved chief vendor and model again and preserves unrelated global settings", async () => {
    writeDefaults()
    vi.mocked(stepAgentType).mockImplementation(async (context) => {
      expect(context.agentType).toBe("codex")
      expect(context.agentModel).toBe("saved-chief-model")
      return undefined
    })
    await setup({ mode: "order" })
    const defaults = parse(readFileSync(settingsPath, "utf-8"))
    expect(defaults.actor.model).toBe("saved-chief-model")
    expect(defaults.server.port).toBe(9900)
  })

  it("clears a stale model when the user chooses a different chief with its native default", async () => {
    writeDefaults()
    vi.mocked(stepAgentType).mockImplementation(async (context) => {
      context.agentType = "claude"
      delete context.agentModel
      return undefined
    })
    await setup()
    const defaults = parse(readFileSync(settingsPath, "utf-8"))
    expect(defaults.actor.type).toBe("claude")
    expect(defaults.actor.model).toBeUndefined()
  })

  it("requires a verification command for analysis orders without tracker report placeholders", async () => {
    vi.mocked(p.select).mockResolvedValue("analysis")
    await setup()
    const project = parse(readFileSync("av.yaml", "utf-8"))
    expect(project).toEqual({ workspace: { root: repo }, verify: { command: "test -s output.md" } })
    expect(p.text).toHaveBeenCalledTimes(2)
  })

  it("keeps the tracker wizard available explicitly", async () => {
    vi.mocked(stepTrackerKind).mockResolvedValue(CANCEL)
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("cancelled")
    })
    await expect(setup({ mode: "tracker" })).rejects.toThrow("cancelled")
    expect(stepTrackerKind).toHaveBeenCalledOnce()
    expect(detectInviteFromClipboard).toHaveBeenCalledOnce()
    expect(existsSync("av.yaml")).toBe(false)
  })

  it("rebuilds a malformed existing project file after replacement is confirmed", async () => {
    writeDefaults()
    writeFileSync("av.yaml", "workspace: [invalid YAML\n")
    await setup()
    expect(p.log.warn).toHaveBeenCalledWith(expect.stringContaining("Existing av.yaml cannot be read"))
    expect(parse(readFileSync("av.yaml", "utf-8")).workspace.root).toBe(repo)
  })

  it.each([
    { name: "malformed YAML", content: "agent: [invalid YAML\n", retainedPort: 9741 },
    {
      name: "invalid Chief Director model with valid unrelated settings",
      content:
        "agent:\n  type: codex\n  model: 42\n  timeout: 120\nserver:\n  port: 9900\nteam:\n  id: retained-team\n",
      retainedPort: 9900,
    },
  ])("repairs $name after warning and confirmed save", async ({ content, retainedPort }) => {
    writeDefaults()
    writeFileSync(settingsPath, content)
    await setup()
    const defaults = parse(readFileSync(settingsPath, "utf-8"))
    expect(defaults.actor.type).toBe("codex")
    expect(defaults.actor.model).toBe("chosen-chief-model")
    expect(globalConfigSchema.safeParse(defaults).success).toBe(true)
    expect(defaults.server.port).toBe(retainedPort)
    if (retainedPort === 9900) {
      expect(defaults.actor.timeout).toBe(120)
      expect(defaults.team.id).toBe("retained-team")
    }
    expect(p.log.warn).toHaveBeenCalledWith(expect.stringContaining("settings.yaml"))
    expect(vi.mocked(p.log.warn).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(p.confirm).mock.invocationCallOrder.at(-1) as number,
    )
    expect(parse(readFileSync("av.yaml", "utf-8")).verify.command).toBe("test -s output.md")
  })

  it("leaves invalid global content untouched when the final save is declined", async () => {
    writeDefaults()
    const content = "agent: [invalid YAML\n"
    writeFileSync(settingsPath, content)
    vi.mocked(p.confirm).mockResolvedValue(false)
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("cancelled")
    })
    await expect(setup()).rejects.toThrow("cancelled")
    expect(readFileSync(settingsPath, "utf-8")).toBe(content)
    expect(existsSync("av.yaml")).toBe(false)
  })

  it("does not silently replace invalid globals when saveConfig is called without repair confirmation", async () => {
    writeDefaults()
    const content = "agent:\n  model: 42\n"
    writeFileSync(settingsPath, content)
    const result = resolveContext({
      trackerKind: "none",
      workspaceRoot: repo,
      agentType: "codex",
      verifyCommand: "true",
    })
    if (!result.ok) throw new Error(result.error)
    await expect(saveConfig(result.ctx)).rejects.toThrow("Global config validation failed")
    expect(readFileSync(settingsPath, "utf-8")).toBe(content)
    expect(existsSync("av.yaml")).toBe(false)
  })

  it("edits order chief defaults and verification without exposing tracker fields", async () => {
    writeDefaults()
    writeFileSync(
      "av.yaml",
      `workspace:\n  root: ${repo}\nverify:\n  command: old\nagent:\n  type: codex\n  timeout: 120\n`,
    )
    vi.mocked(p.multiselect).mockResolvedValue(["agentType", "completion"])
    vi.mocked(p.text).mockReset().mockResolvedValue("test -s updated.md")
    vi.mocked(stepAgentType).mockImplementation(async (context) => {
      expect(context.agentModel).toBe("saved-chief-model")
      context.agentType = "claude"
      delete context.agentModel
      return undefined
    })
    await setupEdit()
    const defaults = parse(readFileSync(settingsPath, "utf-8"))
    const project = parse(readFileSync("av.yaml", "utf-8"))
    expect(defaults.actor.type).toBe("claude")
    expect(defaults.actor.model).toBeUndefined()
    expect(project.verify.command).toBe("test -s updated.md")
    expect(project.tracker).toBeUndefined()
    expect(project.actor).toEqual({ type: "codex", timeout: 120 })
    expect(project.agent).toBeUndefined()
    expect(defaults.agent).toBeUndefined()
    expect(stepOma).toHaveBeenCalledWith(expect.objectContaining({ workspaceRoot: repo }), 2, 2)
    const fields = vi.mocked(p.multiselect).mock.calls[0]?.[0].options
    expect(fields?.map((field) => field.value)).not.toContain("apiKey")
    expect(fields?.map((field) => field.value)).not.toContain("webhookSecret")
  })

  it.each([false, true])("keeps the invite flow with invalid globals=%s", async (invalid) => {
    writeDefaults()
    if (invalid) writeFileSync(settingsPath, "agent:\n  type: codex\n  model: 42\nserver:\n  port: 9900\n")
    vi.mocked(stepApiKey).mockImplementation(async (context) => {
      context.linear = { ...context.linear, apiKey: "lin_api_fixture" }
      return undefined
    })
    vi.mocked(stepAgentType).mockImplementation(async (context) => {
      expect(context.agentType).toBe("codex")
      expect(context.agentModel).toBe(invalid ? undefined : "saved-chief-model")
      context.agentModel = "saved-chief-model"
      return undefined
    })
    await fastTrackSetup({
      teamId: "TEAM",
      teamUuid: "team-id",
      webhookSecret: "webhook-fixture",
      todoStateId: "todo",
      inProgressStateId: "active",
      doneStateId: "done",
      cancelledStateId: "cancelled",
      agentType: "claude",
      serverPort: "9741",
    })
    expect(parse(readFileSync("av.yaml", "utf-8")).tracker.kind).toBe("linear")
    expect(parse(readFileSync(settingsPath, "utf-8")).actor.model).toBe("saved-chief-model")
    expect(parse(readFileSync(settingsPath, "utf-8")).server.port).toBe(9900)
    if (invalid) expect(p.log.warn).toHaveBeenCalledWith(expect.stringContaining("settings.yaml"))
    expect(stepAgentType).toHaveBeenCalledOnce()
    expect(stepOma).toHaveBeenCalledWith(expect.objectContaining({ workspaceRoot: repo }), 4, 7)
    expect(vi.mocked(stepOma).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(stepAgentType).mock.invocationCallOrder[0] as number,
    )
  })

  it("prepares only OMA when selected in edit and leaves existing config unchanged", async () => {
    writeDefaults()
    const content = `workspace:\n  root: ${repo}\nverify:\n  command: test -s output.md\n`
    writeFileSync("av.yaml", content)
    vi.mocked(p.multiselect).mockResolvedValue(["oma"])
    await setupEdit()
    expect(stepOma).toHaveBeenCalledWith(expect.objectContaining({ workspaceRoot: repo }), 1, 1)
    expect(stepAgentType).not.toHaveBeenCalled()
    expect(readFileSync("av.yaml", "utf-8")).toBe(content)
    expect(readFileSync(settingsPath, "utf-8")).toContain("model: saved-chief-model")
  })

  it("returns to edit field selection when the only OMA step requests Back", async () => {
    writeDefaults()
    writeFileSync("av.yaml", `workspace:\n  root: ${repo}\nverify:\n  command: old\n`)
    vi.mocked(p.multiselect).mockResolvedValueOnce(["oma"]).mockResolvedValueOnce(["completion"])
    vi.mocked(stepOma).mockResolvedValueOnce(BACK)
    vi.mocked(p.text).mockReset().mockResolvedValue("test -s updated.md")
    await setupEdit()
    expect(p.multiselect).toHaveBeenCalledTimes(2)
    expect(stepOma).toHaveBeenCalledOnce()
    expect(parse(readFileSync("av.yaml", "utf-8")).verify.command).toBe("test -s updated.md")
  })

  it("does not create a missing repository or save partial configuration", async () => {
    const missing = join(root, "missing")
    const result = resolveContext({
      trackerKind: "none",
      workspaceRoot: missing,
      agentType: "codex",
      verifyCommand: "true",
    })
    if (!result.ok) throw new Error(result.error)
    await expect(saveConfig(result.ctx)).rejects.toThrow("does not exist")
    expect(existsSync(missing)).toBe(false)
    expect(existsSync("av.yaml")).toBe(false)
    expect(existsSync(settingsPath)).toBe(false)
  })

  it("rejects ordinary directories and Git repositories with no commit", async () => {
    const ordinary = join(root, "ordinary")
    mkdirSync(ordinary)
    expect(await validateOrderWorkspace(ordinary)).toContain("not a readable Git worktree")
    const empty = join(root, "empty")
    createRepository(empty, false)
    expect(await validateOrderWorkspace(empty)).toContain("initial Git commit")
    expect(await validateOrderWorkspace(repo)).toBeUndefined()
  })

  it("allows Chief-designed checks for a trackerless analysis context without verify.command", () => {
    const result = resolveContext({
      trackerKind: "none",
      workspaceRoot: repo,
      agentType: "codex",
      task: { kind: "analysis", report_path: "reports/{{attempt.id}}.md" },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.ctx.verifyCommand).toBeUndefined()
  })

  it("previews only the active order fields and the selected chief model", () => {
    const result = resolveContext({
      trackerKind: "none",
      workspaceRoot: repo,
      agentType: "codex",
      agentModel: "chosen-chief-model",
      verifyCommand: "true",
    })
    if (!result.ok) throw new Error(result.error)
    expect(result.ctx.maxParallel).toBe(1)
    expect(result.ctx.tunnel.provider).toBe("none")
    const preview = renderPreview(result.ctx)
    expect(preview).toContain("chosen-chief-model")
    expect(preview).toContain("workspace.root")
    expect(preview).toContain("verify.command")
    expect(preview).not.toContain("tracker.kind")
    expect(preview).not.toContain("github.")
    expect(preview).not.toContain("delivery.mode")
    expect(preview).not.toContain("tunnel.provider")
  })
})
