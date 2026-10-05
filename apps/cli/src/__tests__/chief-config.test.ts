import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chiefConfigSchema } from "@agent-valley/core/config/chief-schema"
import { loadGlobalConfig } from "@agent-valley/core/config/yaml-loader"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentAvailability } from "../agent-discovery"
import { defaultPersonas, resolveOrderConfig } from "../chief-config"

vi.mock("@agent-valley/core/config/yaml-loader", async (original) => ({
  ...(await original<typeof import("@agent-valley/core/config/yaml-loader")>()),
  loadGlobalConfig: vi.fn(() => null),
}))

let root: string
const discover = vi.fn<() => Promise<AgentAvailability[]>>()
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "chief-config-"))
  vi.mocked(loadGlobalConfig).mockReturnValue(null)
  discover.mockResolvedValue([
    { agentType: "claude", readiness: "ready", reason: "Authenticated" },
    { agentType: "codex", readiness: "ready", reason: "Authenticated" },
    { agentType: "cursor", readiness: "unknown", reason: "Authentication could not be detected" },
  ])
})
afterEach(async () => {
  vi.clearAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe("chief order configuration", () => {
  it("resolves inherited container observation and preserves an explicit disabled project override", async () => {
    const globalChief = chiefConfigSchema.parse({
      container_observation: { targets: [{ id: "api", kind: "docker", container: "app-api", context: "orbstack" }] },
    })
    vi.mocked(loadGlobalConfig).mockReturnValue({ chief: globalChief })
    const inherited = await resolveOrderConfig(root, { workspace: root }, discover)
    expect(inherited.containerObservationPolicy).toEqual(globalChief.container_observation)
    await writeFile(
      join(root, "av.yaml"),
      JSON.stringify({
        chief: {
          container_observation: {
            enabled: false,
            targets: [{ id: "worker", kind: "kubernetes", namespace: "app", pod: "worker-1", container: "worker" }],
          },
        },
      }),
    )
    const override = await resolveOrderConfig(root, { workspace: root }, discover)
    expect(override.containerObservationPolicy).toMatchObject({
      enabled: false,
      targets: [{ id: "worker", kind: "kubernetes", namespace: "app", pod: "worker-1", container: "worker" }],
    })
    expect(override.containerObservationPolicy?.targets).toHaveLength(1)
  })

  it("reports the container key and av.yaml path before actor discovery for an invalid target", async () => {
    await writeFile(
      join(root, "av.yaml"),
      JSON.stringify({
        chief: { container_observation: { targets: [{ id: "api", kind: "docker", container: "--all" }] } },
      }),
    )
    await expect(resolveOrderConfig(root, { workspace: root }, discover)).rejects.toThrow(
      "chief.container_observation.targets.0.container",
    )
    await expect(resolveOrderConfig(root, { workspace: root }, discover)).rejects.toThrow(join(root, "av.yaml"))
    expect(discover).not.toHaveBeenCalled()
  })

  it("uses the Chief Director vendor and model saved by setup without per-order flags", async () => {
    vi.mocked(loadGlobalConfig).mockReturnValue({ agent: { type: "codex", model: "configured-chief-model" } })
    await writeFile(join(root, "av.yaml"), `workspace:\n  root: ${root}\nverify:\n  command: "true"\n`)
    const config = await resolveOrderConfig(root, {}, discover)
    expect(config.personas.find((persona) => persona.id === "chief-director")).toMatchObject({
      agentType: "codex",
      model: "configured-chief-model",
    })
    expect(
      config.personas.filter((persona) => persona.id !== "chief-director").every((persona) => !persona.model),
    ).toBe(true)
  })

  it("uses the project Chief Director model before the same vendor's global default", async () => {
    vi.mocked(loadGlobalConfig).mockReturnValue({ agent: { type: "codex", model: "global-model" } })
    await writeFile(join(root, "av.yaml"), `agent:\n  model: project-model\n`)
    const config = await resolveOrderConfig(root, { workspace: root, verify: "true" }, discover)
    expect(config.personas.find((persona) => persona.id === "chief-director")?.model).toBe("project-model")
    const override = await resolveOrderConfig(
      root,
      { workspace: root, verify: "true", model: "explicit-model" },
      discover,
    )
    expect(override.personas.find((persona) => persona.id === "chief-director")?.model).toBe("explicit-model")
  })

  it("keeps a model from one vendor out of an explicitly different Chief Director CLI", async () => {
    vi.mocked(loadGlobalConfig).mockReturnValue({ agent: { type: "claude", model: "claude-only-model" } })
    discover.mockResolvedValue([{ agentType: "codex", readiness: "ready", reason: "Authenticated" }])
    const config = await resolveOrderConfig(root, { workspace: root, verify: "true", agent: "codex" }, discover)
    expect(config.personas.find((persona) => persona.id === "chief-director")).toMatchObject({ agentType: "codex" })
    expect(config.personas.find((persona) => persona.id === "chief-director")).not.toHaveProperty("model")
  })

  it("discovers authenticated candidates without tracker, global settings or personas", async () => {
    const config = await resolveOrderConfig(root, { workspace: root, verify: "test -s report.md" }, discover)
    expect(config).toMatchObject({
      workspace: root,
      verifyCommand: "test -s report.md",
      chiefId: "chief-director",
      timeoutSec: 600,
      maxRepairs: 2,
      maxRounds: 8,
      oma: false,
      availableAgents: ["claude", "codex"],
    })
    expect(config.personas).toHaveLength(9)
    expect(config.personas.find((persona) => persona.id === config.technicalLeadId)?.role).toContain("maintainable")
    expect(config.personas.find((persona) => persona.id === config.designLeadId)?.role).toContain("dark patterns")
    expect(config.personas.find((persona) => persona.id === config.marketingLeadId)?.role).toContain("ROI")
    expect(config.personas.every((persona) => persona.skills.length === 0)).toBe(true)
    expect(loadGlobalConfig).toHaveBeenCalledOnce()
    expect(discover).toHaveBeenCalledOnce()
  })

  it("uses a project verification command and agent with CLI overrides", async () => {
    await writeFile(
      join(root, "av.yaml"),
      `workspace:\n  root: ${root}\nverify:\n  command: test -s project.md\nagent:\n  type: codex\n  timeout: 42\n`,
    )
    const config = await resolveOrderConfig(root, { repairs: "0" }, discover)
    expect(config.verifyCommand).toBe("test -s project.md")
    expect(config.timeoutSec).toBe(42)
    expect(config.personas.every((persona) => persona.agentType === "codex")).toBe(true)
    expect(config.availableAgents).toEqual(["claude", "codex"])
    discover.mockClear()
    const override = await resolveOrderConfig(
      root,
      { agent: "claude", model: "chief-test-model", verify: "test -s override.md", timeout: "8" },
      discover,
    )
    expect(override.timeoutSec).toBe(8)
    expect(override.verifyCommand).toBe("test -s override.md")
    expect(override.availableAgents).toEqual(["claude", "codex"])
    expect(override.personas.find((persona) => persona.id === "chief-director")?.model).toBe("chief-test-model")
    expect(
      override.personas.filter((persona) => persona.id !== "chief-director").every((persona) => !persona.model),
    ).toBe(true)
    expect(discover).toHaveBeenCalledOnce()
  })

  it("keeps the saved Chief Director choice while discovering other authenticated workers", async () => {
    await writeFile(join(root, "av.yaml"), `agent:\n  type: claude\n  model: saved-chief-model\n`)
    discover.mockResolvedValue([{ agentType: "codex", readiness: "ready", reason: "Authenticated" }])
    const config = await resolveOrderConfig(root, { workspace: root, verify: "true" }, discover)
    expect(config.availableAgents).toEqual(["codex", "claude"])
    expect(config.personas.find((persona) => persona.id === "chief-director")).toMatchObject({
      agentType: "claude",
      model: "saved-chief-model",
    })
  })

  it("reports how to install or select an agent when no authentication can be detected", async () => {
    discover.mockResolvedValue([{ agentType: "claude", readiness: "unavailable", reason: "Install Claude Code" }])
    await expect(resolveOrderConfig(root, { workspace: root, verify: "true" }, discover)).rejects.toThrow("av doctor")
    await expect(resolveOrderConfig(root, { workspace: root, verify: "true" }, discover)).rejects.toThrow(
      "claude: Install Claude Code",
    )
  })

  it("allows a manually configured Chief Director while discovering other authenticated worker CLIs", async () => {
    discover.mockResolvedValue([{ agentType: "codex", readiness: "ready", reason: "Authenticated" }])
    const config = await resolveOrderConfig(
      root,
      { workspace: root, verify: "true", agent: "claude", model: "chosen-chief-model" },
      discover,
    )
    expect(config.availableAgents).toEqual(["codex", "claude"])
    expect(config.personas.find((persona) => persona.id === "chief-director")).toMatchObject({
      agentType: "claude",
      model: "chosen-chief-model",
    })
  })

  it.each(["", " ", "m".repeat(257)])("rejects invalid Chief Director model %j before discovery", async (model) => {
    await expect(resolveOrderConfig(root, { workspace: root, verify: "true", model }, discover)).rejects.toThrow(
      "--model",
    )
    expect(discover).not.toHaveBeenCalled()
  })

  it("only assigns OMA skills when explicitly enabled", () => {
    expect(defaultPersonas("claude", false).every((persona) => persona.skills.length === 0)).toBe(true)
    expect(defaultPersonas("claude", true).find((persona) => persona.id === "backend")?.skills).toEqual(["oma-backend"])
  })

  it.each([
    [{ verify: "true" }, "workspace.root"],
    [{ workspace: "relative", verify: "true" }, "absolute"],
    [{ verify: " " }, "workspace.root"],
  ])("rejects an unusable workspace: %j", async (options, message) => {
    await expect(resolveOrderConfig(root, options, discover)).rejects.toThrow(message)
    expect(discover).not.toHaveBeenCalled()
  })

  it("delegates missing verification to Chief and requires a supported runner", async () => {
    expect(await resolveOrderConfig(root, { workspace: root }, discover)).toMatchObject({ verifyCommand: "" })
    await expect(
      resolveOrderConfig(root, { workspace: root, verify: "true", agent: "missing" }, discover),
    ).rejects.toThrow("Unknown actor")
    await expect(
      resolveOrderConfig(root, { workspace: root, verify: "true", chief: "unknown" }, discover),
    ).rejects.toThrow("not in the roster")
  })

  it.each(["-1", "abc", "1.5", "86401", "0"])("rejects invalid timeout %s", async (timeout) => {
    await expect(resolveOrderConfig(root, { workspace: root, verify: "true", timeout }, discover)).rejects.toThrow(
      "--timeout",
    )
    expect(discover).not.toHaveBeenCalled()
  })

  it.each(["-1", "11", "1.5"])("rejects invalid repair budget %s", async (repairs) => {
    await expect(resolveOrderConfig(root, { workspace: root, verify: "true", repairs }, discover)).rejects.toThrow(
      "--repairs",
    )
    expect(discover).not.toHaveBeenCalled()
  })

  it.each(["0", "-1", "51", "1.5", "abc"])(
    "rejects invalid Chief Director recovery limit %s before discovery",
    async (rounds) => {
      await expect(resolveOrderConfig(root, { workspace: root, verify: "true", rounds }, discover)).rejects.toThrow(
        "--rounds",
      )
      expect(discover).not.toHaveBeenCalled()
    },
  )

  it("loads a custom persona roster and rejects missing profiles and unknown chiefs", async () => {
    const profile = {
      chief: "lead",
      personas: [
        { id: "lead", name: "Lead", role: "Coordinate", agentType: "claude", skills: [] },
        { id: "builder", name: "Builder", role: "Build", agentType: "codex", skills: [] },
      ],
    }
    await writeFile(join(root, "personas.yaml"), JSON.stringify(profile))
    const config = await resolveOrderConfig(
      root,
      { workspace: root, verify: "true", personas: "personas.yaml" },
      discover,
    )
    expect(config.chiefId).toBe("lead")
    expect(config.personas.slice(0, profile.personas.length)).toEqual(profile.personas)
    expect(config.technicalLeadId).toBe("technical-director")
    expect(config.personas.find((persona) => persona.id === "technical-director")).toMatchObject({
      agentType: "claude",
      skills: [],
    })
    expect(config.personas.find((persona) => persona.id === config.designLeadId)).toMatchObject({
      agentType: "claude",
      skills: [],
    })
    expect(config).not.toHaveProperty("availableAgents")
    expect(discover).toHaveBeenCalledOnce()
    const override = await resolveOrderConfig(
      root,
      { workspace: root, verify: "true", personas: "personas.yaml", agent: "cursor", model: "chosen-model" },
      discover,
    )
    expect(override.personas.find((persona) => persona.id === "lead")).toMatchObject({
      agentType: "cursor",
      model: "chosen-model",
    })
    expect(override.personas.find((persona) => persona.id === "builder")).toEqual(profile.personas[1])
    await expect(
      resolveOrderConfig(root, { workspace: root, verify: "true", personas: "missing.yaml" }, discover),
    ).rejects.toThrow("missing or empty")
    await expect(
      resolveOrderConfig(
        root,
        { workspace: root, verify: "true", personas: "personas.yaml", chief: "absent" },
        discover,
      ),
    ).rejects.toThrow("not in the roster")
  })
})
