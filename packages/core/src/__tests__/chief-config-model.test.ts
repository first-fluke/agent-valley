import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadGlobalConfig, loadProjectConfig } from "../config/yaml-loader"

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "chief-model-config-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("persisted Chief models", () => {
  it("loads a model default from either configuration file", async () => {
    const settings = join(root, "settings.yaml")
    const yaml = 'agent:\n  type: codex\n  model: " chosen-model "\n'
    await writeFile(settings, yaml)
    await writeFile(join(root, "av.yaml"), yaml)
    expect(loadGlobalConfig(settings)?.agent).toMatchObject({ type: "codex", model: "chosen-model" })
    expect(loadProjectConfig(root)?.agent).toMatchObject({ type: "codex", model: "chosen-model" })
  })

  it.each(["", " ", "m".repeat(257)])("rejects unusable model identifiers in both config files", async (model) => {
    const yaml = `agent:\n  type: codex\n  model: ${JSON.stringify(model)}\n`
    const settings = join(root, "settings.yaml")
    await writeFile(settings, yaml)
    await writeFile(join(root, "av.yaml"), yaml)
    expect(() => loadGlobalConfig(settings)).toThrow("agent.model")
    expect(() => loadProjectConfig(root)).toThrow("agent.model")
  })
})
