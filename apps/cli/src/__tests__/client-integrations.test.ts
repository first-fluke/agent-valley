import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { installClientIntegrations, installClientIntegrationsCommand, parseClientToml } from "../client-integrations"
import { mcpBlockStart } from "../client-integrations-config"
import { applyIntegrationFiles, integrationFile } from "../client-integrations-files"

let temporary: string
let workspace: string
let home: string
let skillRoot: string
const skill = "---\nname: av\ndescription: Manage AV missions.\n---\nCheck AGENT_VALLEY_MANAGED_RUN.\n"

function parseToml(source: string): unknown {
  return parseClientToml(source)
}

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

async function install() {
  return installClientIntegrations(workspace, { sourceSkillRoot: skillRoot, parseToml })
}

beforeEach(async () => {
  temporary = await realpath(await mkdtemp(join(tmpdir(), "av-client-integrations-")))
  workspace = join(temporary, "project 한글 with spaces")
  home = join(temporary, "home")
  skillRoot = join(temporary, "product-skill")
  await mkdir(workspace)
  await put(join(workspace, ".git/HEAD"), "ref: refs/heads/main\n")
  await put(join(skillRoot, "SKILL.md"), skill)
  await put(join(home, ".codex/config.toml"), "model = 'personal-model'\n")
  await put(join(home, ".claude.json"), '{"personal":true}\n')
  await put(join(home, ".qwen/settings.json"), '{"personal":true}\n')
  await put(join(home, ".cursor/mcp.json"), '{"personal":true}\n')
  await put(join(home, ".gemini/config/mcp_config.json"), '{"personal":true}\n')
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await rm(temporary, { recursive: true, force: true })
})

test("installs five clients with one shared Codex/Antigravity skill without touching profiles or managed OMA", async () => {
  await put(join(workspace, ".agents/skills/keep/SKILL.md"), "managed by OMA\n")
  const result = await install()
  expect(result.clients).toEqual(["codex", "claude", "qwen", "cursor", "antigravity"])
  expect(result.files).toHaveLength(13)
  expect(new Set(result.files).size).toBe(result.files.length)
  const expected = { command: "av", args: ["mcp", "--workspace", workspace] }
  for (const client of result.clients)
    expect(
      await readFile(
        join(workspace, `${["codex", "antigravity"].includes(client) ? ".agents" : `.${client}`}/skills/av/SKILL.md`),
        "utf8",
      ),
    ).toBe(skill)
  expect(parseToml(await readFile(join(workspace, ".codex/config.toml"), "utf8"))).toEqual({
    mcp_servers: { av: expected },
  })
  expect(JSON.parse(await readFile(join(workspace, ".mcp.json"), "utf8"))).toEqual({
    mcpServers: { av: { type: "stdio", ...expected } },
  })
  expect(JSON.parse(await readFile(join(workspace, ".qwen/settings.json"), "utf8"))).toEqual({
    mcpServers: { av: expected },
  })
  for (const path of [".cursor/mcp.json", ".agents/mcp_config.json"])
    expect(JSON.parse(await readFile(join(workspace, path), "utf8"))).toEqual({ mcpServers: { av: expected } })
  expect(await readFile(join(home, ".codex/config.toml"), "utf8")).toBe("model = 'personal-model'\n")
  expect(await readFile(join(home, ".claude.json"), "utf8")).toBe('{"personal":true}\n')
  expect(await readFile(join(home, ".qwen/settings.json"), "utf8")).toBe('{"personal":true}\n')
  expect(await readFile(join(home, ".cursor/mcp.json"), "utf8")).toBe('{"personal":true}\n')
  expect(await readFile(join(home, ".gemini/config/mcp_config.json"), "utf8")).toBe('{"personal":true}\n')
  expect(await readFile(join(workspace, ".agents/skills/keep/SKILL.md"), "utf8")).toBe("managed by OMA\n")
})

test("preserves other settings, MCP entries, comments, permission policies, modes and skills", async () => {
  const toml = '# user comment\nmodel = "chosen"\n[mcp_servers.other]\ncommand = "other"\nargs = ["--local"]\n'
  const claude = { permissionMode: "default", mcpServers: { other: { command: "other" } } }
  const qwen = {
    security: { auth: { selectedType: "custom" } },
    mcp: { excluded: ["av"] },
    mcpServers: { other: { command: "other" } },
  }
  await put(join(workspace, ".codex/config.toml"), toml)
  await chmod(join(workspace, ".codex/config.toml"), 0o640)
  await put(join(workspace, ".mcp.json"), JSON.stringify(claude))
  await chmod(join(workspace, ".mcp.json"), 0o600)
  await put(join(workspace, ".qwen/settings.json"), JSON.stringify(qwen))
  await put(join(workspace, ".claude/skills/other/SKILL.md"), "user skill")
  await install()
  expect((await readFile(join(workspace, ".codex/config.toml"), "utf8")).startsWith(toml)).toBe(true)
  const parsed = JSON.parse(await readFile(join(workspace, ".qwen/settings.json"), "utf8"))
  expect(parsed.security).toEqual(qwen.security)
  expect(parsed.mcp).toEqual(qwen.mcp)
  expect(parsed.mcpServers.other).toEqual(qwen.mcpServers.other)
  expect(JSON.parse(await readFile(join(workspace, ".mcp.json"), "utf8")).permissionMode).toBe("default")
  expect((await lstat(join(workspace, ".codex/config.toml"))).mode & 0o777).toBe(0o640)
  expect((await lstat(join(workspace, ".mcp.json"))).mode & 0o777).toBe(0o600)
  expect(await readFile(join(workspace, ".claude/skills/other/SKILL.md"), "utf8")).toBe("user skill")
})

test.each([".cursor/mcp.json", ".agents/mcp_config.json"])(
  "preserves existing %s settings, other servers, file modes and user skills",
  async (path) => {
    const before = {
      existing: { selection: "unchanged" },
      mcpServers: { other: { serverUrl: "https://example.test/mcp", disabled: true } },
    }
    await put(join(workspace, path), JSON.stringify(before))
    await chmod(join(workspace, path), 0o640)
    await put(join(workspace, ".cursor/skills/other/SKILL.md"), "custom Cursor skill")
    await put(join(workspace, ".agents/skills/custom/SKILL.md"), "custom Antigravity skill")
    await install()
    const after = JSON.parse(await readFile(join(workspace, path), "utf8"))
    expect(after.existing).toEqual(before.existing)
    expect(after.mcpServers.other).toEqual(before.mcpServers.other)
    expect(after.mcpServers.av).toEqual({ command: "av", args: ["mcp", "--workspace", workspace] })
    expect((await lstat(join(workspace, path))).mode & 0o777).toBe(0o640)
    expect(await readFile(join(workspace, ".cursor/skills/other/SKILL.md"), "utf8")).toBe("custom Cursor skill")
    expect(await readFile(join(workspace, ".agents/skills/custom/SKILL.md"), "utf8")).toBe("custom Antigravity skill")
  },
)

test("A configuration remains bound while client skills and settings install in its B target", async () => {
  const projectRoot = join(temporary, "AV config A")
  await mkdir(projectRoot)
  const avConfig = `workspace:\n  root: ${workspace}\nchief:\n  execution:\n    max_duration_sec: 120\n`
  await put(join(projectRoot, "av.yaml"), avConfig)
  const result = await installClientIntegrations(workspace, { projectRoot, sourceSkillRoot: skillRoot })
  expect(result.projectRoot).toBe(projectRoot)
  expect(result.workspaceRoot).toBe(workspace)
  const expected = { command: "av", args: ["mcp", "--workspace", projectRoot] }
  expect(parseToml(await readFile(join(workspace, ".codex/config.toml"), "utf8"))).toEqual({
    mcp_servers: { av: expected },
  })
  for (const path of [".mcp.json", ".qwen/settings.json", ".cursor/mcp.json", ".agents/mcp_config.json"])
    expect(JSON.parse(await readFile(join(workspace, path), "utf8")).mcpServers.av).toMatchObject(expected)
  expect(await readFile(join(workspace, ".agents/skills/av/SKILL.md"), "utf8")).toBe(skill)
  expect(await readFile(join(projectRoot, "av.yaml"), "utf8")).toBe(avConfig)
  await expect(lstat(join(projectRoot, ".mcp.json"))).rejects.toMatchObject({ code: "ENOENT" })
  await expect(lstat(join(projectRoot, ".agents/skills/av"))).rejects.toMatchObject({ code: "ENOENT" })
  expect((await installClientIntegrations(workspace, { projectRoot, sourceSkillRoot: skillRoot })).files).toEqual([])
})

test("projectRoot is canonicalized and invalid directories fail before installation", async () => {
  const project = join(temporary, "config")
  await mkdir(project)
  const alias = join(temporary, "config-alias")
  await symlink(project, alias)
  const result = await installClientIntegrations(workspace, { projectRoot: alias, sourceSkillRoot: skillRoot })
  expect(result.projectRoot).toBe(project)
  expect(JSON.parse(await readFile(join(workspace, ".mcp.json"), "utf8")).mcpServers.av.args).toEqual([
    "mcp",
    "--workspace",
    project,
  ])
  const untouched = join(temporary, "untouched target")
  await mkdir(untouched)
  for (const invalid of [join(temporary, "missing config"), join(project, "av.yaml")]) {
    await put(join(project, "av.yaml"), "workspace: {}\n")
    await expect(
      installClientIntegrations(untouched, { projectRoot: invalid, sourceSkillRoot: skillRoot }),
    ).rejects.toThrow("projectRoot")
  }
  await expect(lstat(join(untouched, ".mcp.json"))).rejects.toMatchObject({ code: "ENOENT" })
})

test("reruns are byte-for-byte idempotent and update only unchanged owned skill files", async () => {
  await install()
  const toml = await readFile(join(workspace, ".codex/config.toml"), "utf8")
  expect((await install()).files).toEqual([])
  expect(toml.split(mcpBlockStart)).toHaveLength(2)
  await put(join(workspace, ".agents/skills/av/operator.txt"), "keep this unrelated file")
  await writeFile(join(skillRoot, "SKILL.md"), `${skill}Updated instruction.\n`)
  expect((await install()).files).toHaveLength(8)
  expect(await readFile(join(workspace, ".codex/config.toml"), "utf8")).toBe(toml)
  expect(await readFile(join(workspace, ".agents/skills/av/operator.txt"), "utf8")).toBe("keep this unrelated file")
})

test.each(["codex", "claude", "qwen", "cursor", "antigravity"])(
  "unowned %s AV skill prevents every client mutation",
  async (client) => {
    const conflict = join(
      workspace,
      `${["codex", "antigravity"].includes(client) ? ".agents" : `.${client}`}/skills/av/SKILL.md`,
    )
    await put(conflict, "operator skill")
    await expect(install()).rejects.toThrow("unowned")
    expect(await readFile(conflict, "utf8")).toBe("operator skill")
    await expect(lstat(join(workspace, ".mcp.json"))).rejects.toMatchObject({ code: "ENOENT" })
    if (!["codex", "antigravity"].includes(client))
      await expect(lstat(join(workspace, ".agents/skills/av"))).rejects.toMatchObject({ code: "ENOENT" })
  },
)

test.each(["qwen", "cursor"])(
  "local modifications to an owned %s skill are retained without updating other clients",
  async (client) => {
    await install()
    await writeFile(join(workspace, `.${client}/skills/av/SKILL.md`), `${skill}My custom instructions.\n`)
    await writeFile(join(skillRoot, "SKILL.md"), `${skill}Product update.\n`)
    await expect(install()).rejects.toThrow("changed locally")
    expect(await readFile(join(workspace, ".agents/skills/av/SKILL.md"), "utf8")).toBe(skill)
    expect(await readFile(join(workspace, `.${client}/skills/av/SKILL.md`), "utf8")).toContain("My custom instructions")
  },
)

test.each([
  [".mcp.json", '{"mcpServers":{"av":{"command":"another"}}}'],
  [".qwen/settings.json", '{"mcpServers":{"av":{"command":"another"}}}'],
  [".cursor/mcp.json", '{"mcpServers":{"av":{"command":"another"}}}'],
  [".agents/mcp_config.json", '{"mcpServers":{"av":{"serverUrl":"https://example.test/mcp"}}}'],
  [".codex/config.toml", '[mcp_servers."av"]\ncommand="another"\n'],
  [".codex/config.toml", 'mcp_servers = { av = { command = "another" } }\n'],
])("a conflicting MCP server in %s is preserved and blocks skill creation", async (path, content) => {
  await put(join(workspace, path), content)
  await expect(install()).rejects.toThrow("already belongs to a different server")
  expect(await readFile(join(workspace, path), "utf8")).toBe(content)
  await expect(lstat(join(workspace, ".agents/skills/av"))).rejects.toMatchObject({ code: "ENOENT" })
})

test("matching manually configured AV entries keep custom per-tool policies verbatim", async () => {
  const args = JSON.stringify(["mcp", "--workspace", workspace])
  const toml = `[mcp_servers.av]\ncommand="av"\nargs=${args}\nenabled=false\ntool_timeout_sec=200\n[mcp_servers.av.tools.av_order]\napproval_mode="prompt"\n`
  const json = `{"mcpServers":{"av":{"command":"av","args":${args},"trust":false,"excludeTools":["av_order"]}}}`
  await put(join(workspace, ".codex/config.toml"), toml)
  await put(join(workspace, ".qwen/settings.json"), json)
  await install()
  expect(await readFile(join(workspace, ".codex/config.toml"), "utf8")).toBe(toml)
  expect(await readFile(join(workspace, ".qwen/settings.json"), "utf8")).toBe(json)
})

test.each([".cursor/mcp.json", ".agents/mcp_config.json"])(
  "matching %s AV entry keeps disabled and approval restrictions byte-for-byte",
  async (path) => {
    const entry = {
      command: "av",
      args: ["mcp", "--workspace", workspace],
      disabled: true,
      includeTools: ["av_status"],
      env: { EXISTING_SETTING: "retained" },
    }
    const source = JSON.stringify({ mcpServers: { av: entry } })
    await put(join(workspace, path), source)
    await install()
    expect(await readFile(join(workspace, path), "utf8")).toBe(source)
  },
)

test("Antigravity serverUrl on an otherwise matching AV entry remains an unowned transport conflict", async () => {
  const path = join(workspace, ".agents/mcp_config.json")
  const source = JSON.stringify({
    mcpServers: {
      av: { command: "av", args: ["mcp", "--workspace", workspace], serverUrl: "https://example.test/mcp" },
    },
  })
  await put(path, source)
  await expect(install()).rejects.toThrow("already belongs to a different server")
  expect(await readFile(path, "utf8")).toBe(source)
  await expect(lstat(join(workspace, ".cursor/skills/av"))).rejects.toMatchObject({ code: "ENOENT" })
  await expect(lstat(join(workspace, ".codex/config.toml"))).rejects.toMatchObject({ code: "ENOENT" })
})

test.each([
  [".qwen/settings.json", "not json"],
  [".cursor/mcp.json", "not json"],
  [".agents/mcp_config.json", "not json"],
  [".mcp.json", "[]"],
  [".mcp.json", '{"mcpServers":null}'],
  [".mcp.json", '{"mcpServers":[]}'],
  [".codex/config.toml", "not valid = ["],
  [".codex/config.toml", "mcp_servers = 5"],
  [".codex/config.toml", `${mcpBlockStart}\n`],
])("invalid existing %s settings produce actionable failure without writes", async (path, content) => {
  await put(join(workspace, path), content)
  await expect(install()).rejects.toThrow("rerun av integrations install")
  expect(await readFile(join(workspace, path), "utf8")).toBe(content)
  await expect(lstat(join(workspace, ".claude/skills/av"))).rejects.toMatchObject({ code: "ENOENT" })
})

test("symlinked client directories and config files are never followed", async () => {
  await symlink(join(home, ".qwen"), join(workspace, ".qwen"))
  await expect(install()).rejects.toThrow("symbolic links")
  expect(await readFile(join(home, ".qwen/settings.json"), "utf8")).toBe('{"personal":true}\n')
  await rm(join(workspace, ".qwen"))
  await symlink(join(home, ".claude.json"), join(workspace, ".mcp.json"))
  await expect(install()).rejects.toThrow("symbolic links")
  expect(await readFile(join(home, ".claude.json"), "utf8")).toBe('{"personal":true}\n')
})

test.each([
  [".cursor/mcp.json", ".cursor/mcp.json"],
  [".agents/mcp_config.json", ".gemini/config/mcp_config.json"],
])("symlinked %s preserves its user profile and prevents all project installation writes", async (path, profile) => {
  await mkdir(dirname(join(workspace, path)), { recursive: true })
  await symlink(join(home, profile), join(workspace, path))
  await expect(install()).rejects.toThrow("symbolic links")
  expect(await readFile(join(home, profile), "utf8")).toBe('{"personal":true}\n')
  await expect(lstat(join(workspace, ".agents/skills/av"))).rejects.toMatchObject({ code: "ENOENT" })
  await expect(lstat(join(workspace, ".mcp.json"))).rejects.toMatchObject({ code: "ENOENT" })
})

test("changed files after preflight roll back earlier writes without replacing concurrent edits", async () => {
  const first = await integrationFile(workspace, join(workspace, "first.json"), "installed")
  const second = await integrationFile(workspace, join(workspace, "second.json"), "installed")
  await writeFile(second.path, "concurrent edit")
  await expect(applyIntegrationFiles(workspace, [first, second])).rejects.toThrow("changed during installation")
  await expect(lstat(first.path)).rejects.toMatchObject({ code: "ENOENT" })
  expect(await readFile(second.path, "utf8")).toBe("concurrent edit")
})

test("invalid workspace or missing product skill explains the exact fix", async () => {
  await expect(installClientIntegrations(join(temporary, "missing"))).rejects.toThrow("workspace.root")
  await rm(join(skillRoot, "SKILL.md"))
  await expect(install()).rejects.toThrow("complete Agent Valley checkout")
  await writeFile(join(skillRoot, "SKILL.md"), "broken")
  await expect(install()).rejects.toThrow("Restore integrations/skills/av/SKILL.md")
})

test("the shipped product skill and command action install without starting a mission", async () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => {})
  await installClientIntegrationsCommand({ workspace })
  const content = await readFile(join(workspace, ".agents/skills/av/SKILL.md"), "utf8")
  expect(content).toBe(await readFile(resolve("integrations/skills/av/SKILL.md"), "utf8"))
  expect(content).toContain("AGENT_VALLEY_MANAGED_RUN")
  expect(content).toContain("An accepted or started order is incomplete")
  expect(output).toHaveBeenCalledWith(expect.stringContaining("does not verify the client connection"))
})

test("default TOML parser works in the packaged Node runtime without Bun and preserves big integers", () => {
  vi.stubGlobal("Bun", undefined)
  expect(parseClientToml('model="chosen"')).toEqual({ model: "chosen" })
  expect(parseClientToml("large = 9223372036854775807")).toEqual({ large: 9223372036854775807n })
})
