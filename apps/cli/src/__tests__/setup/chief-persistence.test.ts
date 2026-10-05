import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chiefConfigSchema } from "@agent-valley/core/config/chief-schema"
import * as p from "@clack/prompts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parse, stringify } from "yaml"
import { stepChief } from "../../setup/chief-step"
import { setupEdit } from "../../setup/edit"
import { fastTrackSetup } from "../../setup/fast-track"
import { setup } from "../../setup/index"
import { stepOma } from "../../setup/oma-step"
import { resolveContext } from "../../setup/resolve"
import { saveConfig } from "../../setup/save"
import { BACK, CANCEL, type SetupContext } from "../../setup/types"

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
vi.mock("../../invite", () => ({ detectInviteFromClipboard: vi.fn().mockResolvedValue(null) }))
vi.mock("../../setup/chief-step", () => ({ stepChief: vi.fn() }))
vi.mock("../../setup/oma-step", () => ({ stepOma: vi.fn() }))
vi.mock("../../setup/agent-step", () => ({
  stepAgentType: vi.fn(async (ctx: SetupContext) => {
    ctx.agentType = "codex"
  }),
}))
vi.mock("../../setup/linear-step", () => ({
  stepApiKey: vi.fn(async (ctx: SetupContext) => {
    ctx.linear = { ...ctx.linear, apiKey: "lin_api_fixture" }
  }),
}))
vi.mock("../../setup/workspace-step", () => ({
  validateOrderWorkspace: vi.fn().mockResolvedValue(undefined),
  stepWorkspace: vi.fn(async (ctx: SetupContext) => {
    ctx.workspaceRoot ??= process.cwd()
  }),
}))
vi.mock("../../setup/completion-step", () => ({
  stepCompletion: vi.fn(async (ctx: SetupContext) => {
    ctx.verifyCommand = "test -s output.md"
  }),
}))
vi.mock("../../setup/parallel-step", () => ({
  stepParallel: vi.fn(async (ctx: SetupContext) => {
    ctx.maxParallel = 2
  }),
}))
let originalCwd: string
let originalXdg: string | undefined
let root: string
let settings: string
const projectChief = () =>
  chiefConfigSchema.parse({
    memory: false,
    review_vendor: "require",
    metric_targets: [{ name: "revenue", unit: "USD", direction: "increase", target: 100 }],
    reporting: { destinations: [{ id: "old", channel: "webhook", url_env: "OLD_REPORT_URL" }] },
  })
const globalChief = () =>
  chiefConfigSchema.parse({
    routing: { candidates: [{ actor_type: "codex", model: "global-model" }] },
    capture: { enabled: true, target_url: "https://example.test/global" },
  })
function writeDefaults(): void {
  mkdirSync(join(root, "config", "agent-valley"), { recursive: true })
  writeFileSync(settings, stringify({ actor: { type: "codex", model: "chief-model" }, chief: globalChief() }))
  writeFileSync("av.yaml", stringify({ workspace: { root }, verify: { command: "old-check" }, chief: projectChief() }))
}
function context(extra: Partial<SetupContext> = {}) {
  const resolved = resolveContext({
    trackerKind: "none",
    workspaceRoot: root,
    agentType: "codex",
    agentModel: "chief-model",
    verifyCommand: "test -s output.md",
    ...extra,
  })
  if (!resolved.ok) throw new Error(resolved.error)
  return resolved.ctx
}
beforeEach(() => {
  vi.clearAllMocks()
  originalCwd = process.cwd()
  originalXdg = process.env.XDG_CONFIG_HOME
  root = mkdtempSync(join(tmpdir(), "av-chief-setup-"))
  settings = join(root, "config", "agent-valley", "settings.yaml")
  process.chdir(root)
  process.env.XDG_CONFIG_HOME = join(root, "config")
  vi.mocked(p.confirm).mockResolvedValue(true)
  vi.mocked(p.multiselect).mockResolvedValue(["chief"])
  vi.mocked(stepChief).mockReset().mockResolvedValue(undefined)
  vi.mocked(stepOma).mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  process.chdir(originalCwd)
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalXdg
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe("Chief integration persistence", () => {
  it("preserves global/project advanced settings and integrations when no explicit change was made", async () => {
    writeDefaults()
    await saveConfig(context())
    expect(parse(readFileSync(settings, "utf8")).chief).toEqual(globalChief())
    expect(parse(readFileSync("av.yaml", "utf8")).chief).toEqual(projectChief())
  })

  it("writes only the changed reporting/capture fields while retaining project metric and memory policy", async () => {
    writeDefaults()
    const changed = chiefConfigSchema.parse({
      ...globalChief(),
      reporting: { destinations: [{ id: "new", channel: "discord", url_env: "DISCORD_REPORT_URL" }] },
      capture: { enabled: true, tab_id: "chosen-tab", video: false },
    })
    await saveConfig(context({ chief: changed, chiefChanged: true }))
    const project = parse(readFileSync("av.yaml", "utf8"))
    expect(project.chief).toEqual({ ...projectChief(), reporting: changed.reporting, capture: changed.capture })
    expect(project.chief.routing).toBeUndefined()
    expect(parse(readFileSync(settings, "utf8")).chief).toEqual(globalChief())
    expect(readFileSync("av.yaml", "utf8")).not.toContain("secret-value")
  })

  it("can override globally enabled integrations with explicit project disabled values", async () => {
    writeDefaults()
    const disabled = chiefConfigSchema.parse({ reporting: { destinations: [] }, capture: { enabled: false } })
    await saveConfig(context({ chief: disabled, chiefChanged: true }))
    const chief = parse(readFileSync("av.yaml", "utf8")).chief
    expect(chief.reporting.destinations).toEqual([])
    expect(chief.capture.enabled).toBe(false)
    expect(chief.metric_targets).toEqual(projectChief().metric_targets)
    expect(parse(readFileSync(settings, "utf8")).chief.capture.enabled).toBe(true)
  })

  it("saves new metric sources and targets while keeping inherited capture and routing global", async () => {
    writeDefaults()
    const changed = chiefConfigSchema.parse({
      ...globalChief(),
      ...projectChief(),
      metric_sources: { sources: [{ id: "revenue", name: "revenue", unit: "USD", url_env: "BUSINESS_METRIC_URL" }] },
      metric_targets: [{ name: "revenue", unit: "USD", direction: "increase", target: 200 }],
    })
    await saveConfig(context({ chief: changed, chiefChanged: true, verifyCommand: undefined }))
    const project = parse(readFileSync("av.yaml", "utf8"))
    expect(project.verify).toBeUndefined()
    expect(project.chief.metric_sources.sources[0].url_env).toBe("BUSINESS_METRIC_URL")
    expect(project.chief.metric_targets[0].target).toBe(200)
    expect(project.chief.reporting).toEqual(projectChief().reporting)
    expect(project.chief.capture).toBeUndefined()
    expect(project.chief.routing).toBeUndefined()
    expect(parse(readFileSync(settings, "utf8")).chief).toEqual(globalChief())
  })

  it("saves new container targets without copying unrelated inherited policies into av.yaml", async () => {
    writeDefaults()
    const changed = chiefConfigSchema.parse({
      ...globalChief(),
      ...projectChief(),
      container_observation: {
        targets: [{ id: "api", kind: "docker", container: "app-api", context: "orbstack" }],
      },
    })
    await saveConfig(context({ chief: changed, chiefChanged: true }))
    const saved = parse(readFileSync("av.yaml", "utf8")).chief
    expect(saved.container_observation).toEqual(changed.container_observation)
    expect(saved.memory).toBe(false)
    expect(saved.reporting).toEqual(projectChief().reporting)
    expect(saved.capture).toBeUndefined()
    expect(saved.routing).toBeUndefined()
    expect(parse(readFileSync(settings, "utf8")).chief).toEqual(globalChief())
  })

  it("persists disabling inherited container targets through edit while leaving the global policy active", async () => {
    writeDefaults()
    const inherited = chiefConfigSchema.parse({
      ...globalChief(),
      container_observation: {
        targets: [{ id: "api", kind: "docker", container: "app-api", context: "orbstack" }],
      },
    })
    writeFileSync(settings, stringify({ actor: { type: "codex", model: "chief-model" }, chief: inherited }))
    const oldGlobal = readFileSync(settings, "utf8")
    vi.mocked(stepChief).mockImplementation(async (ctx) => {
      ctx.chief = chiefConfigSchema.parse({
        ...ctx.chief,
        container_observation: { ...ctx.chief?.container_observation, enabled: false },
      })
      ctx.chiefChanged = true
    })
    await setupEdit()
    const saved = parse(readFileSync("av.yaml", "utf8")).chief
    expect(saved.container_observation).toEqual({ ...inherited.container_observation, enabled: false })
    expect(saved.metric_targets).toEqual(projectChief().metric_targets)
    expect(saved.capture).toBeUndefined()
    expect(saved.routing).toBeUndefined()
    expect(readFileSync(settings, "utf8")).toBe(oldGlobal)
    expect(parse(readFileSync(settings, "utf8")).chief.container_observation.enabled).toBe(true)
  })

  it("does not silently replace a malformed project when direct save was not authorized to repair it", async () => {
    writeDefaults()
    writeFileSync("av.yaml", "chief: [broken YAML\n")
    await expect(saveConfig(context())).rejects.toThrow("Failed to parse av.yaml")
    expect(readFileSync("av.yaml", "utf8")).toBe("chief: [broken YAML\n")
  })

  it("loads effective integration defaults in normal setup after OMA and before confirmation", async () => {
    writeDefaults()
    await setup()
    expect(stepChief).toHaveBeenCalledWith(
      expect.objectContaining({ chief: { ...globalChief(), ...projectChief() } }),
      4,
      5,
    )
    expect(vi.mocked(stepChief).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(stepOma).mock.invocationCallOrder[0] as number,
    )
    expect(parse(readFileSync("av.yaml", "utf8")).chief).toEqual(projectChief())
  })

  it("returns from the new setup step to OMA without losing context", async () => {
    vi.mocked(stepChief).mockResolvedValueOnce(BACK).mockResolvedValueOnce(undefined)
    await setup()
    expect(stepChief).toHaveBeenCalledTimes(2)
    expect(stepOma).toHaveBeenCalledTimes(2)
    expect(existsSync("av.yaml")).toBe(true)
  })

  it("does not save when integration setup is cancelled", async () => {
    vi.mocked(stepChief).mockResolvedValue(CANCEL)
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("cancelled")
    })
    await expect(setup()).rejects.toThrow("cancelled")
    expect(existsSync("av.yaml")).toBe(false)
    expect(existsSync(settings)).toBe(false)
  })

  it("edits integrations without provisioning agents or modifying unrelated global/project policies", async () => {
    writeDefaults()
    vi.mocked(stepChief).mockImplementation(async (ctx) => {
      expect(ctx.chief).toEqual({ ...globalChief(), ...projectChief() })
      ctx.chief = chiefConfigSchema.parse({
        ...ctx.chief,
        reporting: { destinations: [] },
        capture: { enabled: false },
      })
      ctx.chiefChanged = true
    })
    const oldGlobal = readFileSync(settings, "utf8")
    await setupEdit()
    const chief = parse(readFileSync("av.yaml", "utf8")).chief
    expect(chief.memory).toBe(false)
    expect(chief.review_vendor).toBe("require")
    expect(chief.metric_targets).toEqual(projectChief().metric_targets)
    expect(chief.reporting.destinations).toEqual([])
    expect(chief.capture.enabled).toBe(false)
    expect(readFileSync(settings, "utf8")).toBe(oldGlobal)
    expect(stepOma).not.toHaveBeenCalled()
  })

  it("persists edited metric sources and targets without copying inherited global policies", async () => {
    writeDefaults()
    vi.mocked(stepChief).mockImplementation(async (ctx) => {
      ctx.chief = chiefConfigSchema.parse({
        ...ctx.chief,
        metric_sources: {
          sources: [
            { id: "conversion", name: "conversion", unit: "ratio", adapter: "json-file", file: "metrics.json" },
          ],
        },
        metric_targets: [{ name: "conversion", unit: "ratio", direction: "increase", target: 0.2 }],
      })
      ctx.chiefChanged = true
    })
    const oldGlobal = readFileSync(settings, "utf8")
    await setupEdit()
    const chief = parse(readFileSync("av.yaml", "utf8")).chief
    expect(chief.metric_sources.sources[0].file).toBe("metrics.json")
    expect(chief.metric_targets[0].target).toBe(0.2)
    expect(chief.reporting).toEqual(projectChief().reporting)
    expect(chief.capture).toBeUndefined()
    expect(chief.routing).toBeUndefined()
    expect(readFileSync(settings, "utf8")).toBe(oldGlobal)
  })

  it("keeps project bytes unchanged when edit retains the current integration settings", async () => {
    writeDefaults()
    const old = readFileSync("av.yaml", "utf8")
    await setupEdit()
    expect(readFileSync("av.yaml", "utf8")).toBe(old)
  })

  it("returns Back to edit selection and leaves the existing file unchanged", async () => {
    writeDefaults()
    const old = readFileSync("av.yaml", "utf8")
    vi.mocked(stepChief).mockResolvedValueOnce(BACK).mockResolvedValueOnce(undefined)
    await setupEdit()
    expect(p.multiselect).toHaveBeenCalledTimes(2)
    expect(readFileSync("av.yaml", "utf8")).toBe(old)
  })

  it("runs the same integration step in the invite flow and preserves existing project policies", async () => {
    writeDefaults()
    await fastTrackSetup({
      teamId: "TEAM",
      teamUuid: "team-uuid",
      serverPort: "9741",
      webhookSecret: "fixture",
      todoStateId: "todo",
      inProgressStateId: "progress",
      doneStateId: "done",
      cancelledStateId: "cancelled",
      agentType: "codex",
    })
    expect(stepChief).toHaveBeenCalledWith(
      expect.objectContaining({ chief: { ...globalChief(), ...projectChief() } }),
      5,
      7,
    )
    expect(parse(readFileSync("av.yaml", "utf8")).chief).toEqual(projectChief())
  })
})
