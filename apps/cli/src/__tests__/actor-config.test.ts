import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentAvailability } from "../agent-discovery"
import { registerChiefCommands } from "../chief"
import { resolveOrderConfig } from "../chief-config"

vi.mock("@agent-valley/core/config/yaml-loader", async (original) => ({
  ...(await original<typeof import("@agent-valley/core/config/yaml-loader")>()),
  loadGlobalConfig: vi.fn(() => null),
}))

let root: string
const discover = vi.fn<() => Promise<AgentAvailability[]>>()
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "actor-config-"))
  discover.mockResolvedValue([{ agentType: "claude", readiness: "ready", reason: "Authenticated" }])
})
afterEach(async () => {
  vi.clearAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe("Actor configuration compatibility", () => {
  it("uses av.yaml and the complete actor block before conflicting legacy values", async () => {
    await writeFile(join(root, "valley.yaml"), "verify:\n  command: legacy-check\nagent:\n  type: grok\n")
    await writeFile(
      join(root, "av.yaml"),
      "verify:\n  command: canonical-check\nagent:\n  type: grok\n  model: legacy-model\nactor:\n  type: codex\n",
    )
    const result = await resolveOrderConfig(root, { workspace: root }, discover)
    expect(result.verifyCommand).toBe("canonical-check")
    expect(result.chiefId).toBe("chief-director")
    expect(result.personas.find((actor) => actor.id === result.chiefId)).toMatchObject({ agentType: "codex" })
    expect(result.personas.find((actor) => actor.id === result.chiefId)).not.toHaveProperty("model")
    expect([result.technicalLeadId, result.designLeadId, result.marketingLeadId]).toEqual([
      "technical-director",
      "design-director",
      "marketing-director",
    ])
  })

  it("reads an Actor profile while canonical flags override legacy aliases", async () => {
    await writeFile(join(root, "av.yaml"), "verify:\n  command: project-check\n")
    await writeFile(
      join(root, "actors.yaml"),
      JSON.stringify({
        director: "lead",
        actors: [
          { id: "lead", name: "Lead", role: "Coordinate", actorType: "claude", skills: [] },
          { id: "writer", name: "Writer", role: "Write evidence", actorType: "codex", skills: [] },
          { id: "cto", name: "Technical Director", role: "Existing technical role", actorType: "codex", skills: [] },
          { id: "cdo", name: "Design Director", role: "Existing design role", actorType: "claude", skills: [] },
          { id: "cmo", name: "Marketing Director", role: "Existing marketing role", actorType: "claude", skills: [] },
        ],
      }),
    )
    const result = await resolveOrderConfig(
      root,
      {
        workspace: root,
        actors: "actors.yaml",
        personas: "missing.yaml",
        actor: "cursor",
        agent: "grok",
        director: "lead",
        chief: "missing",
      },
      discover,
    )
    expect(result.verifyCommand).toBe("project-check")
    expect(result.chiefId).toBe("lead")
    expect(result.personas).toHaveLength(5)
    expect(result.personas.find((actor) => actor.id === "lead")?.agentType).toBe("cursor")
    expect([result.technicalLeadId, result.designLeadId, result.marketingLeadId]).toEqual(["cto", "cdo", "cmo"])
    expect(result.personas.some((actor) => actor.id === "technical-director")).toBe(false)
    expect(discover).toHaveBeenCalledOnce()
    expect(result.operatingPolicy.readyActors).toEqual(["claude"])
  })

  it("shows canonical options and retains hidden legacy option parsers", () => {
    const program = new Command()
    registerChiefCommands(program)
    const order = program.commands.find((command) => command.name() === "order")
    if (!order) throw new Error("Missing order command.")
    const help = order.helpInformation()
    expect(help).toContain("--actor <type>")
    expect(help).toContain("--director <id>")
    expect(help).toContain("--actors <file>")
    expect(help).not.toContain("--agent ")
    expect(help).not.toContain("--chief ")
    expect(help).not.toContain("--personas ")
    expect(order.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--agent", "--chief", "--personas"]),
    )
  })

  it("does not load project defaults from valley.yaml alone", async () => {
    await writeFile(
      join(root, "valley.yaml"),
      "workspace:\n  root: /ignored-repository\nverify:\n  command: ignored-check\nactor:\n  type: grok\n",
    )
    const config = await resolveOrderConfig(root, { workspace: root }, discover)
    expect(config.workspace).toBe(root)
    expect(config.verifyCommand).toBe("")
    expect(config.personas.find((actor) => actor.id === config.chiefId)?.agentType).not.toBe("grok")
    expect(discover).toHaveBeenCalledOnce()
  })
})
