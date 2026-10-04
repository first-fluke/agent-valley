import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { promisify } from "node:util"
import { Command } from "commander"
import { afterEach, describe, expect, it, vi } from "vitest"
import { registerPluginCommands } from "../plugin-commands"
import { exportPluginPackages, type PluginExportOptions } from "../plugin-export"

const temporary: string[] = []
const run = promisify(execFile)

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(): Promise<PluginExportOptions & { root: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "av-plugin-export-")))
  temporary.push(root)
  const workspace = join(root, "AV project with spaces")
  await mkdir(workspace)
  return { root, workspace, output: join(root, "export") }
}

async function json(path: string) {
  return JSON.parse(await readFile(path, "utf8"))
}

describe("AV plugin exports", () => {
  it("emits native vendor packages and resolves every marketplace source inside its root", async () => {
    const options = await fixture()
    const result = await exportPluginPackages(options)
    expect(result.transport).toBe("stdio")
    const local = { command: "av", args: ["mcp", "--workspace", options.workspace] }
    expect((await json(join(result.packages.portable, "mcp.json"))).mcpServers.av).toEqual({ type: "stdio", ...local })
    expect((await json(join(result.packages.claude, ".mcp.json"))).mcpServers.av).toEqual({ type: "stdio", ...local })
    expect((await json(join(result.packages.cursor, "mcp.json"))).mcpServers.av).toEqual(local)
    expect((await json(join(result.packages.qwen, "qwen-extension.json"))).mcpServers.av).toEqual(local)
    expect((await json(join(result.packages.antigravity, "mcp_config.json"))).mcpServers.av).toEqual(local)

    const portable = await json(join(result.packages.portable, "plugin.json"))
    expect(portable.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json")
    expect(portable.extensions["com.openai"].interface.shortDescription.length).toBeLessThanOrEqual(30)
    expect(portable.extensions["com.openai"].interface.longDescription).not.toBe("")
    expect((await json(join(result.packages.claude, ".claude-plugin/plugin.json"))).name).toBe("av")
    const cursor = await json(join(result.packages.cursor, ".cursor-plugin/plugin.json"))
    expect(cursor.mcpServers).toBe("./mcp.json")
    expect(cursor.skills).toBe("./skills/")
    expect((await json(join(result.packages.qwen, "qwen-extension.json"))).skills).toBe("skills")
    expect(Object.keys(await json(join(result.packages.antigravity, "plugin.json"))).sort()).toEqual([
      "description",
      "name",
    ])
    expect((await json(join(result.packages.portable, "mcp.json"))).$schema).toBe(
      "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    )

    const marketplace = await json(join(result.output, "portable/.agents/plugins/marketplace.json"))
    expect(marketplace.plugins[0]).toEqual({
      name: "av",
      source: { source: "local", path: "./av" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    })
    expect(await realpath(join(result.output, "portable", marketplace.plugins[0].source.path))).toBe(
      result.packages.portable,
    )
    for (const vendor of ["claude", "cursor"] as const) {
      const nativeMarket = await json(join(result.output, vendor, `.${vendor}-plugin/marketplace.json`))
      expect(await realpath(join(result.output, vendor, nativeMarket.plugins[0].source))).toBe(result.packages[vendor])
    }
    const source = await readFile(new URL("../../../../integrations/skills/av/SKILL.md", import.meta.url), "utf8")
    const license = await readFile(new URL("../../../../LICENSE", import.meta.url), "utf8")
    for (const path of Object.values(result.packages)) {
      expect(await readFile(join(path, "skills/av/SKILL.md"), "utf8")).toBe(source)
      expect(await readFile(join(path, "LICENSE"), "utf8")).toBe(license)
    }
    const receipt = await json(join(result.output, ".agent-valley-plugins.json"))
    expect(Object.keys(receipt.files).filter((path) => path.endsWith("/LICENSE"))).toHaveLength(5)
    expect((await exportPluginPackages(options)).files).toEqual([])
  })

  it("keeps the project bound when the exported server launches from another working directory", async () => {
    const options = await fixture()
    const result = await exportPluginPackages(options)
    const command = (await json(join(result.packages.portable, "mcp.json"))).mcpServers.av
    const bin = join(options.root, "fake-bin")
    const otherDirectory = join(options.root, "unrelated-project")
    const observed = join(options.root, "observed-args.json")
    await mkdir(bin)
    await mkdir(otherDirectory)
    await writeFile(
      join(bin, "av"),
      "#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.AV_TEST_ARGS, JSON.stringify(process.argv.slice(2)))\n",
    )
    await chmod(join(bin, "av"), 0o755)
    await run(command.command, command.args, {
      cwd: otherDirectory,
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, AV_TEST_ARGS: observed },
    })
    expect(await json(observed)).toEqual(["mcp", "--workspace", options.workspace])
  })

  it("emits each client's HTTP contract without exposing local project paths or storing credentials", async () => {
    const options = { ...(await fixture()), remoteUrl: "https://av.example.org/mcp" }
    const result = await exportPluginPackages(options)
    expect(result.transport).toBe("streamable-http")
    expect((await json(join(result.packages.portable, "mcp.json"))).mcpServers.av).toEqual({
      type: "streamable-http",
      url: options.remoteUrl,
    })
    expect((await json(join(result.packages.claude, ".mcp.json"))).mcpServers.av).toEqual({
      type: "http",
      url: options.remoteUrl,
    })
    expect((await json(join(result.packages.cursor, "mcp.json"))).mcpServers.av).toEqual({ url: options.remoteUrl })
    expect((await json(join(result.packages.qwen, "qwen-extension.json"))).mcpServers.av).toEqual({
      httpUrl: options.remoteUrl,
    })
    expect((await json(join(result.packages.antigravity, "mcp_config.json"))).mcpServers.av).toEqual({
      serverUrl: options.remoteUrl,
    })
    for (const path of result.files) {
      const content = await readFile(path, "utf8")
      expect(content).not.toContain(options.workspace)
      expect(content).not.toContain('"Authorization":')
      expect(content).not.toContain("${PLUGIN_ROOT}")
    }
  })

  it("updates owned skill copies when the shared source changes", async () => {
    const options = await fixture()
    const sourceSkillRoot = join(options.root, "skill")
    await mkdir(sourceSkillRoot)
    const original = "---\nname: av\ndescription: Test delegation\n---\nAGENT_VALLEY_MANAGED_RUN\nFirst instruction\n"
    await writeFile(join(sourceSkillRoot, "SKILL.md"), original)
    await exportPluginPackages({ ...options, sourceSkillRoot })
    const changed = original.replace("First instruction", "Updated instruction")
    await writeFile(join(sourceSkillRoot, "SKILL.md"), changed)
    const result = await exportPluginPackages({ ...options, sourceSkillRoot })
    expect(result.files.filter((path) => path.endsWith("SKILL.md"))).toHaveLength(5)
    for (const path of Object.values(result.packages))
      expect(await readFile(join(path, "skills/av/SKILL.md"), "utf8")).toBe(changed)
  })

  it("preserves local edits and rejects the complete export before updating other packages", async () => {
    const options = await fixture()
    const result = await exportPluginPackages(options)
    const edited = join(result.packages.cursor, "mcp.json")
    const originalPortable = await readFile(join(result.packages.portable, "mcp.json"), "utf8")
    await writeFile(edited, "local custom configuration\n")
    await expect(exportPluginPackages({ ...options, remoteUrl: "https://av.example.org/mcp" })).rejects.toThrow(
      "changed or removed locally",
    )
    expect(await readFile(edited, "utf8")).toBe("local custom configuration\n")
    expect(await readFile(join(result.packages.portable, "mcp.json"), "utf8")).toBe(originalPortable)
  })

  it("updates owned licenses together and preserves a locally edited license before any other write", async () => {
    const options = await fixture()
    const sourceLicense = join(options.root, "LICENSE")
    const original = await readFile(new URL("../../../../LICENSE", import.meta.url), "utf8")
    await writeFile(sourceLicense, original)
    await exportPluginPackages({ ...options, sourceLicense })
    const changed = `${original}\n`
    await writeFile(sourceLicense, changed)
    const result = await exportPluginPackages({ ...options, sourceLicense })
    expect(result.files.filter((path) => path.endsWith("/LICENSE"))).toHaveLength(5)
    for (const path of Object.values(result.packages))
      expect(await readFile(join(path, "LICENSE"), "utf8")).toBe(changed)
    const edited = join(result.packages.antigravity, "LICENSE")
    await writeFile(edited, "local license edit\n")
    const portableMcp = join(result.packages.portable, "mcp.json")
    const before = await readFile(portableMcp, "utf8")
    await expect(
      exportPluginPackages({ ...options, sourceLicense, remoteUrl: "https://av.example.org/mcp" }),
    ).rejects.toThrow("changed or removed locally")
    expect(await readFile(edited, "utf8")).toBe("local license edit\n")
    expect(await readFile(portableMcp, "utf8")).toBe(before)
  })

  it("does not create a partial export when its packaged license is missing", async () => {
    const options = await fixture()
    await expect(exportPluginPackages({ ...options, sourceLicense: join(options.root, "missing") })).rejects.toThrow(
      "restore integrations/LICENSE",
    )
    await expect(readFile(join(options.output, "README.md"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("retains unowned files and refuses an output symlink", async () => {
    const options = await fixture()
    await mkdir(options.output)
    const foreign = join(options.output, "keep.txt")
    await writeFile(foreign, "keep")
    await expect(exportPluginPackages(options)).rejects.toThrow("unowned files are retained")
    expect(await readFile(foreign, "utf8")).toBe("keep")
    const linked = join(options.root, "linked")
    await symlink(options.output, linked)
    await expect(exportPluginPackages({ ...options, output: linked })).rejects.toThrow("symbolic link")
  })

  it("rejects deleted owned files and invalid receipts without changing the export", async () => {
    const options = await fixture()
    const result = await exportPluginPackages(options)
    await rm(join(result.packages.qwen, "qwen-extension.json"))
    await expect(exportPluginPackages(options)).rejects.toThrow("changed or removed locally")
    await writeFile(join(result.output, ".agent-valley-plugins.json"), "invalid receipt")
    await expect(exportPluginPackages(options)).rejects.toThrow("valid AV ownership receipt")
  })

  it.each([
    "http://av.example.org/mcp",
    "https://secret:credential@av.example.org/mcp",
    "https://av.example.org/notmcp",
    "https://av.example.org/nested/mcp",
    "https://av.example.org/mcp/",
    "https://av.example.org/mcp?token=secret",
    "https://av.example.org/mcp#fragment",
    "not a URL",
  ])("rejects an unsafe or unsupported remote endpoint: %s", async (remoteUrl) => {
    const options = await fixture()
    await expect(exportPluginPackages({ ...options, remoteUrl })).rejects.toThrow("authenticated HTTPS /mcp endpoint")
    await expect(readFile(join(options.output, "README.md"))).rejects.toThrow()
  })

  it("requires an existing workspace and a separate destination", async () => {
    const options = await fixture()
    await expect(exportPluginPackages({ ...options, workspace: "" })).rejects.toThrow("--workspace")
    await expect(exportPluginPackages({ ...options, workspace: join(options.root, "missing") })).rejects.toThrow(
      "workspace.root",
    )
    await expect(exportPluginPackages({ ...options, output: "" })).rejects.toThrow("--output")
    await expect(exportPluginPackages({ ...options, output: options.workspace })).rejects.toThrow("separate")
  })

  it("registers the export command and reports actual package paths", async () => {
    const options = await fixture()
    const messages: string[] = []
    vi.spyOn(process.stdout, "write").mockImplementation((value) => {
      messages.push(String(value))
      return true
    })
    const program = new Command().exitOverride()
    registerPluginCommands(program)
    await program.parseAsync(["plugins", "export", "--workspace", options.workspace, "--output", options.output], {
      from: "user",
    })
    expect(messages.join("")).toContain(`Exported AV stdio plugins to ${options.output}`)
    expect(messages.join("")).toContain(`portable: ${options.output}/portable/av`)
    expect(await json(join(options.output, "portable/av/plugin.json"))).toMatchObject({ name: "av" })
  })
})
