import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadGlobalConfig } from "@agent-valley/core/config/yaml-loader"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defaultPersonas, resolveOrderConfig } from "../chief-config"

vi.mock("@agent-valley/core/config/yaml-loader", async (original) => ({
  ...(await original<typeof import("@agent-valley/core/config/yaml-loader")>()),
  loadGlobalConfig: vi.fn(() => null),
}))

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "chief-config-"))
})
afterEach(async () => {
  vi.clearAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe("chief order configuration", () => {
  it("works from explicit options without tracker or global settings", () => {
    const config = resolveOrderConfig(root, { workspace: root, verify: "test -s report.md" })
    expect(config).toMatchObject({
      workspace: root,
      verifyCommand: "test -s report.md",
      chiefId: "chief",
      timeoutSec: 600,
      maxRepairs: 2,
      oma: false,
    })
    expect(config.personas).toHaveLength(6)
    expect(config.personas.every((persona) => persona.skills.length === 0)).toBe(true)
    expect(loadGlobalConfig).toHaveBeenCalledOnce()
  })

  it("uses a project verification command and agent with CLI overrides", async () => {
    await writeFile(
      join(root, "valley.yaml"),
      `workspace:\n  root: ${root}\nverify:\n  command: test -s project.md\nagent:\n  type: codex\n  timeout: 42\n`,
    )
    const config = resolveOrderConfig(root, { repairs: "0" })
    expect(config.verifyCommand).toBe("test -s project.md")
    expect(config.timeoutSec).toBe(42)
    expect(config.personas.every((persona) => persona.agentType === "codex")).toBe(true)
    const override = resolveOrderConfig(root, { agent: "claude", verify: "test -s override.md", timeout: "8" })
    expect(override.timeoutSec).toBe(8)
    expect(override.verifyCommand).toBe("test -s override.md")
  })

  it("only assigns OMA skills when explicitly enabled", () => {
    expect(defaultPersonas("claude", false).every((persona) => persona.skills.length === 0)).toBe(true)
    expect(defaultPersonas("claude", true).find((persona) => persona.id === "backend")?.skills).toEqual(["oma-backend"])
  })

  it.each([
    [{ verify: "true" }, "workspace.root"],
    [{ workspace: "relative", verify: "true" }, "absolute"],
    [{ verify: " " }, "workspace.root"],
  ])("rejects an unusable workspace: %j", (options, message) => {
    expect(() => resolveOrderConfig(root, options)).toThrow(message)
  })

  it("requires a real verification command and supported runner", () => {
    expect(() => resolveOrderConfig(root, { workspace: root })).toThrow("verify.command")
    expect(() => resolveOrderConfig(root, { workspace: root, verify: "true", agent: "missing" })).toThrow(
      "Unknown agent",
    )
    expect(() => resolveOrderConfig(root, { workspace: root, verify: "true", chief: "unknown" })).toThrow(
      "not in the roster",
    )
  })

  it.each(["-1", "abc", "1.5", "86401", "0"])("rejects invalid timeout %s", (timeout) => {
    expect(() => resolveOrderConfig(root, { workspace: root, verify: "true", timeout })).toThrow("--timeout")
  })

  it.each(["-1", "11", "1.5"])("rejects invalid repair budget %s", (repairs) => {
    expect(() => resolveOrderConfig(root, { workspace: root, verify: "true", repairs })).toThrow("--repairs")
  })

  it("loads a custom persona roster and rejects missing profiles and unknown chiefs", async () => {
    const profile = {
      chief: "lead",
      personas: [
        { id: "lead", name: "Lead", role: "Coordinate", agentType: "claude", skills: [] },
        { id: "builder", name: "Builder", role: "Build", agentType: "codex", skills: [] },
      ],
    }
    await writeFile(join(root, "personas.yaml"), JSON.stringify(profile))
    expect(resolveOrderConfig(root, { workspace: root, verify: "true", personas: "personas.yaml" }).chiefId).toBe(
      "lead",
    )
    expect(() => resolveOrderConfig(root, { workspace: root, verify: "true", personas: "missing.yaml" })).toThrow(
      "missing or empty",
    )
    expect(() =>
      resolveOrderConfig(root, { workspace: root, verify: "true", personas: "personas.yaml", chief: "absent" }),
    ).toThrow("not in the roster")
  })
})
