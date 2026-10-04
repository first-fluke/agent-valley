import { access, readFile, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { loadPluginManifestAsset } from "../plugin-assets"

const repository = fileURLToPath(new URL("../../../../", import.meta.url))
const sourceRoot = join(repository, "integrations")
const author = z.strictObject({ name: z.string().min(1) })
const identity = {
  name: z.literal("av"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().min(1),
}

// Published native formats: Claude plugin-marketplaces/plugins-reference,
// Cursor docs/reference/plugins, and Qwen users/features/skills.
const marketplaceSchema = z.strictObject({
  name: z.literal("agent-valley"),
  owner: author,
  metadata: z.strictObject({ description: z.string().min(1) }),
  plugins: z
    .array(
      z.strictObject({ name: z.literal("av"), source: z.literal("./integrations"), description: z.string().min(1) }),
    )
    .length(1),
})
const nativeSchema = z.strictObject({ ...identity, author, skills: z.literal("./skills/") })
const qwenSchema = z.strictObject({ ...identity, skills: z.literal("skills") })
// Antigravity docs/plugins specifies additionalProperties:false and these two keys.
const antigravitySchema = z.strictObject({ name: identity.name, description: identity.description })

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown
}

describe("public skills-only plugin sources", () => {
  it("includes the unchanged repository license in every independently installed public package", async () => {
    const license = await readFile(join(repository, "LICENSE"), "utf8")
    expect(await readFile(join(sourceRoot, "LICENSE"), "utf8")).toBe(license)
    expect(await readFile(join(sourceRoot, "plugins/antigravity/av/LICENSE"), "utf8")).toBe(license)
  })

  it("resolves the Claude and Cursor repository catalogs to the shared public source", async () => {
    const { manifest } = await loadPluginManifestAsset([join(sourceRoot, "plugin.json")])
    for (const vendor of ["claude", "cursor"]) {
      const catalog = marketplaceSchema.parse(await json(join(repository, `.${vendor}-plugin/marketplace.json`)))
      const entry = catalog.plugins[0]
      expect(entry).toBeDefined()
      const plugin = resolve(repository, entry?.source ?? "")
      expect(isAbsolute(entry?.source ?? "")).toBe(false)
      expect(relative(repository, plugin).startsWith("..")).toBe(false)
      expect(await realpath(plugin)).toBe(await realpath(sourceRoot))
      expect(entry?.name).toBe(manifest.name)
      expect(entry?.description).toBe(manifest.description)
      expect(catalog.owner).toEqual(manifest.author)
    }
    // OpenAI officially supports this legacy catalog path and plain-string local sources.
    // No managed root .agents catalog is required for Codex repository registration.
    await expect(access(join(repository, ".claude-plugin/marketplace.json"))).resolves.toBeUndefined()
  })

  it("validates native manifests and keeps their identity and discoverable skills in sync", async () => {
    const { manifest } = await loadPluginManifestAsset([join(sourceRoot, "plugin.json")])
    for (const vendor of ["claude", "cursor"]) {
      const native = nativeSchema.parse(await json(join(sourceRoot, `.${vendor}-plugin/plugin.json`)))
      expect(native).toMatchObject({
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author: manifest.author,
      })
      await expect(access(join(sourceRoot, native.skills, "av/SKILL.md"))).resolves.toBeUndefined()
    }
    const qwen = qwenSchema.parse(await json(join(sourceRoot, "qwen-extension.json")))
    expect(qwen).toMatchObject({ name: manifest.name, version: manifest.version, description: manifest.description })
    await expect(access(join(sourceRoot, qwen.skills, "av/SKILL.md"))).resolves.toBeUndefined()
  })

  it("validates the strict Antigravity wrapper and preserves the shared skill bytes", async () => {
    const { manifest } = await loadPluginManifestAsset([join(sourceRoot, "plugin.json")])
    const antigravity = join(sourceRoot, "plugins/antigravity/av")
    expect(antigravitySchema.parse(await json(join(antigravity, "plugin.json")))).toEqual({
      name: manifest.name,
      description: manifest.description,
    })
    expect(await readFile(join(antigravity, "skills/av/SKILL.md"), "utf8")).toBe(
      await readFile(join(sourceRoot, "skills/av/SKILL.md"), "utf8"),
    )
  })

  it("publishes no MCP endpoint, command, credential mapping, or private project binding", async () => {
    const manifests = [
      "plugin.json",
      ".claude-plugin/plugin.json",
      ".cursor-plugin/plugin.json",
      "qwen-extension.json",
      "plugins/antigravity/av/plugin.json",
    ]
    for (const path of manifests) {
      const content = await readFile(join(sourceRoot, path), "utf8")
      for (const runtimeField of ["mcpServers", "serverUrl", "httpUrl", "command", "args", "Authorization"])
        expect(content).not.toContain(`"${runtimeField}"`)
      expect(content).not.toContain("--workspace")
      expect(content).not.toContain(repository)
    }
    for (const path of ["mcp.json", ".mcp.json", "mcp_config.json", "plugins/antigravity/av/mcp_config.json"])
      await expect(access(join(sourceRoot, path))).rejects.toMatchObject({ code: "ENOENT" })
  })
})
