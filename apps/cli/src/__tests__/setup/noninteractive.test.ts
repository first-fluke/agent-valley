import { chmodSync, existsSync, readFileSync, statSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { loadProjectConfig } from "@agent-valley/core/config/yaml-loader"
import * as prompts from "@clack/prompts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setupNoninteractive } from "../../setup/noninteractive"
import type { SetupOptions } from "../../setup/noninteractive-types"
import { createSetupRepository, noninteractiveFixture } from "./noninteractive-fixture"

vi.mock("@clack/prompts", () => ({ select: vi.fn(), confirm: vi.fn(), text: vi.fn() }))

let fixture: ReturnType<typeof noninteractiveFixture>
beforeEach(() => {
  vi.clearAllMocks()
  fixture = noninteractiveFixture()
})
afterEach(() => {
  vi.restoreAllMocks()
  fixture.cleanup()
})

describe("unattended local setup", () => {
  it("does not prompt, binds skills in B to configuration A, and defaults to preparing OMA", async () => {
    const prompt = prompts.select
    const confirm = prompts.confirm
    const text = prompts.text
    const result = await setupNoninteractive(
      { yes: true, actor: "codex", model: "current-model", workspace: fixture.workspace },
      fixture.deps,
    )
    expect(result).toMatchObject({
      status: "ready",
      exitCode: 0,
      projectRoot: fixture.deps.projectRoot,
      workspace: fixture.workspace,
      config: { saved: true },
      chief: { actorType: "codex", model: "current-model", modelSource: "explicit", readiness: "ready" },
      oma: { status: "prepared" },
      integrations: { status: "installed" },
    })
    expect(fixture.deps.prepareOma).toHaveBeenCalledWith(fixture.workspace)
    expect(fixture.deps.installActor).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(text).not.toHaveBeenCalled()
    expect(fixture.json(fixture.projectPath)).toEqual({
      workspace: { root: fixture.workspace },
      actor: { type: "codex", model: "current-model" },
    })
    const entry = JSON.parse(readFileSync(join(fixture.workspace, ".mcp.json"), "utf8")).mcpServers.av
    expect(entry.args).toEqual(["mcp", "--workspace", fixture.deps.projectRoot])
    expect(existsSync(join(fixture.deps.projectRoot, ".agents/skills/av/SKILL.md"))).toBe(false)
  })

  it("uses invocation cwd as the target when no saved workspace exists and explicitly skips OMA", async () => {
    const result = await setupNoninteractive({ yes: true, actor: "claude", oma: "skip" }, fixture.deps)
    expect(result.workspace).toBe(fixture.deps.projectRoot)
    expect(result.oma.status).toBe("skipped")
    expect(fixture.deps.prepareOma).not.toHaveBeenCalled()
  })

  it("preserves unrelated configuration and secrets while updating chosen type/model and hardening modes", async () => {
    fixture.write(
      fixture.globalConfigPath,
      "actor:\n  type: claude\n  model: old-global\n  timeout: 120\nlinear:\n  api_key: fixture-secret\nserver:\n  port: 9911\n",
    )
    fixture.write(
      fixture.projectPath,
      `workspace:\n  root: ${fixture.workspace}\nactor:\n  type: claude\n  model: old-project\n  max_parallel: 4\nverify:\n  command: old-check\n  timeout_sec: 23\nprompt: custom instructions\nchief:\n  memory: false\n`,
    )
    chmodSync(fixture.globalConfigPath, 0o644)
    chmodSync(fixture.projectPath, 0o644)
    const result = await setupNoninteractive(
      { yes: true, actor: "codex", verify: "new trusted check", oma: "skip" },
      fixture.deps,
    )
    expect(result.status).toBe("ready")
    expect(fixture.json(fixture.globalConfigPath)).toEqual({
      actor: { type: "codex", timeout: 120 },
      linear: { api_key: "fixture-secret" },
      server: { port: 9911 },
    })
    expect(fixture.json(fixture.projectPath)).toMatchObject({
      actor: { type: "codex", max_parallel: 4 },
      verify: { command: "new trusted check", timeout_sec: 23 },
      prompt: "custom instructions",
      chief: { memory: false },
    })
    expect(loadProjectConfig(fixture.deps.projectRoot)?.agent).toMatchObject({ type: "codex", max_parallel: 4 })
    expect(JSON.stringify(result)).not.toContain("fixture-secret")
    for (const path of [fixture.projectPath, fixture.globalConfigPath]) expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it("is idempotent and preserves a same-vendor saved model and verification command", async () => {
    fixture.write(fixture.globalConfigPath, "agent:\n  type: codex\n  model: global-model\n")
    fixture.write(
      fixture.projectPath,
      `workspace:\n  root: ${fixture.workspace}\nactor:\n  type: codex\n  model: project-model\nverify:\n  command: saved-check\n`,
    )
    const first = await setupNoninteractive({ yes: true, oma: "skip" }, fixture.deps)
    expect(first.chief).toMatchObject({ actorSource: "project", model: "project-model", modelSource: "project" })
    const content = readFileSync(fixture.projectPath, "utf8")
    const timestamp = statSync(fixture.projectPath).mtimeMs
    const second = await setupNoninteractive({ yes: true, oma: "skip" }, fixture.deps)
    expect(second.integrations.files).toEqual([])
    expect(readFileSync(fixture.projectPath, "utf8")).toBe(content)
    expect(statSync(fixture.projectPath).mtimeMs).toBe(timestamp)
    expect(fixture.json(fixture.projectPath).verify.command).toBe("saved-check")
  })

  it("saves pending authentication without invoking login and completes after a readiness recheck", async () => {
    fixture.deps.inspectActor.mockResolvedValueOnce({
      agentType: "codex",
      readiness: "unauthenticated",
      reason: "Mock login required",
    })
    const result = await setupNoninteractive({ yes: true, actor: "codex", oma: "skip" }, fixture.deps)
    expect(result).toMatchObject({
      status: "action_required",
      exitCode: 2,
      config: { saved: true },
      chief: { readiness: "unauthenticated" },
    })
    expect(result.nextActions.join(" ")).toContain("codex login")
    expect(fixture.deps.installActor).not.toHaveBeenCalled()
    expect((await setupNoninteractive({ yes: true, oma: "skip" }, fixture.deps)).status).toBe("ready")
  })

  it("installs only the selected missing CLI then rechecks its readiness", async () => {
    fixture.deps.inspectActor.mockResolvedValueOnce({
      agentType: "codex",
      readiness: "unavailable",
      reason: "Mock missing CLI",
    })
    const result = await setupNoninteractive({ yes: true, actor: "codex", oma: "skip" }, fixture.deps)
    expect(result.status).toBe("ready")
    expect(fixture.deps.installActor).toHaveBeenCalledOnce()
    expect(fixture.deps.installActor).toHaveBeenCalledWith("codex")
    expect(fixture.deps.inspectActor).toHaveBeenCalledTimes(2)
  })

  it.each(["unknown", "unavailable"])(
    "returns action_required and saves settings for %s readiness",
    async (readiness) => {
      fixture.deps.inspectActor.mockResolvedValue({
        agentType: "codex",
        readiness: readiness as "unknown" | "unavailable",
        reason: "Mock environment action",
      })
      fixture.deps.installActor.mockResolvedValue({ success: false, message: "Mock offline installation failure" })
      const result = await setupNoninteractive({ yes: true, actor: "codex", oma: "skip" }, fixture.deps)
      expect(result).toMatchObject({ status: "action_required", exitCode: 2, config: { saved: true } })
      expect(result.chief.readiness).toBe(readiness)
    },
  )

  it.each([false, true])("does not silently skip OMA failures (throws=%s)", async (throws) => {
    if (throws) fixture.deps.prepareOma.mockRejectedValue(new Error("sensitive native output"))
    else fixture.deps.prepareOma.mockResolvedValue({ success: false, message: "Mock OMA download failed" })
    const result = await setupNoninteractive({ yes: true, actor: "codex" }, fixture.deps)
    expect(result).toMatchObject({ status: "failed", exitCode: 1, oma: { status: "failed" }, config: { saved: true } })
    expect(result.error).toContain("OMA preparation failed")
    expect(JSON.stringify(result)).not.toContain("sensitive native output")
  })

  it("recomputes integration snapshots after OMA changes client settings", async () => {
    fixture.deps.prepareOma.mockImplementation(async () => {
      fixture.write(
        join(fixture.workspace, ".mcp.json"),
        JSON.stringify({ mcpServers: { oma: { command: "oma", args: ["mcp"] } } }),
      )
      return { success: true, message: "Mock OMA wrote a shared MCP config" }
    })
    const result = await setupNoninteractive({ yes: true, actor: "codex", workspace: fixture.workspace }, fixture.deps)
    expect(result.status).toBe("ready")
    expect(fixture.deps.prepareIntegrations).toHaveBeenCalledTimes(2)
    const servers = JSON.parse(readFileSync(join(fixture.workspace, ".mcp.json"), "utf8")).mcpServers
    expect(servers.oma).toEqual({ command: "oma", args: ["mcp"] })
    expect(servers.av.args).toEqual(["mcp", "--workspace", fixture.deps.projectRoot])
  })

  it("requires an initial commit without creating a repository or writing settings", async () => {
    const empty = join(fixture.root, "empty")
    createSetupRepository(empty, false)
    const result = await setupNoninteractive({ yes: true, actor: "codex", workspace: empty }, fixture.deps)
    expect(result.error).toContain("initial Git commit")
    expect(fixture.deps.prepareOma).not.toHaveBeenCalled()
    expect(existsSync(fixture.projectPath)).toBe(false)
    expect(existsSync(fixture.globalConfigPath)).toBe(false)
  })

  it.each([
    { yes: false },
    { yes: true, mode: "tracker" },
    { yes: true, edit: true },
    { yes: true, actor: "invalid" },
    { yes: true, oma: "force" },
    { yes: true, model: "a\nb" },
    { yes: true, verify: " " },
    { yes: true, workspace: " " },
  ] satisfies SetupOptions[])("rejects unsupported options before any effects: %j", async (options) => {
    const result = await setupNoninteractive(options, fixture.deps)
    expect(result).toMatchObject({ status: "failed", exitCode: 1, config: { saved: false } })
    expect(fixture.deps.prepareIntegrations).not.toHaveBeenCalled()
    expect(fixture.deps.inspectActor).not.toHaveBeenCalled()
    expect(fixture.deps.installActor).not.toHaveBeenCalled()
    expect(fixture.deps.prepareOma).not.toHaveBeenCalled()
    expect(existsSync(fixture.projectPath)).toBe(false)
  })

  it("refuses malformed config without echoing the secret-bearing YAML line", async () => {
    const malformed = "linear: [fixture-private-secret\n"
    fixture.write(fixture.globalConfigPath, malformed)
    const result = await setupNoninteractive({ yes: true, actor: "codex" }, fixture.deps)
    expect(result.error).toContain(fixture.globalConfigPath)
    expect(JSON.stringify(result)).not.toContain("fixture-private-secret")
    expect(readFileSync(fixture.globalConfigPath, "utf8")).toBe(malformed)
    expect(fixture.deps.prepareIntegrations).not.toHaveBeenCalled()
  })

  it("refuses symlink config without writing through it", async () => {
    const original = join(fixture.root, "original.yaml")
    fixture.write(original, "actor:\n  type: codex\n")
    symlinkSync(original, fixture.projectPath)
    const result = await setupNoninteractive({ yes: true, actor: "claude" }, fixture.deps)
    expect(result.error).toContain("symbolic links")
    expect(readFileSync(original, "utf8")).toBe("actor:\n  type: codex\n")
    expect(fixture.deps.inspectActor).not.toHaveBeenCalled()
  })

  it("rejects a conflicting MCP server before config, OMA or provider mutations", async () => {
    fixture.write(
      join(fixture.workspace, ".mcp.json"),
      JSON.stringify({ mcpServers: { av: { command: "other", args: [] } } }),
    )
    const result = await setupNoninteractive({ yes: true, actor: "codex", workspace: fixture.workspace }, fixture.deps)
    expect(result).toMatchObject({
      status: "failed",
      exitCode: 1,
      config: { saved: false },
      integrations: { status: "failed" },
    })
    expect(fixture.deps.inspectActor).not.toHaveBeenCalled()
    expect(fixture.deps.prepareOma).not.toHaveBeenCalled()
    expect(existsSync(fixture.projectPath)).toBe(false)
    expect(existsSync(fixture.globalConfigPath)).toBe(false)
  })
})
