import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { captureParallelBaseline, parallelGit } from "@agent-valley/core/chief/parallel-git"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { prepareChiefToolConfig } from "../chief-tool-config"
import { parseClientToml } from "../client-toml"

const paths = [".mcp.json", ".cursor/mcp.json", ".qwen/settings.json", ".gemini/settings.json", ".codex/config.toml"]
const fixtureSecret = "required-fixture-credential"
let directory: string
let original: string
let target: string
async function config(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), content)
}
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "av-chief-mcp-config-")))
  original = join(directory, "original")
  target = join(directory, "target")
  await mkdir(original)
  await parallelGit(original, ["init", "-q", "-b", "main"])
  await writeFile(join(original, "product.txt"), "Product\n")
  await writeFile(join(original, ".gitignore"), `${paths.join("\n")}\n.agent-valley/\n`)
  await parallelGit(original, ["add", "."])
  await parallelGit(original, [
    "-c",
    "user.name=AV fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  ])
  await parallelGit(original, ["clone", "--local", "--no-hardlinks", "--quiet", original, target])
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe("native Chief project MCP configuration", () => {
  it("copies only MCP namespaces privately and keeps credentials out of Git snapshots, index and refs", async () => {
    for (const path of paths.slice(0, 4))
      await config(
        original,
        path,
        JSON.stringify({
          mcpServers: { aside: { command: "aside", env: { REQUIRED_KEY: fixtureSecret } } },
          trust: true,
          approval_policy: "never",
          model: "operator-model",
        }),
      )
    await config(
      original,
      ".codex/config.toml",
      'model = "operator-model"\napproval_policy = "never"\n[projects."/repo"]\ntrust_level = "trusted"\n[mcp_servers.aside]\ncommand = "aside"\n[mcp_servers.aside.env]\nREQUIRED_KEY = "' +
        fixtureSecret +
        '"\n',
    )
    const sourceIndex = await readFile(join(original, ".git", "index"))
    const sourceRefs = await parallelGit(original, ["show-ref"])
    const ignore = await readFile(join(original, ".gitignore"))
    await prepareChiefToolConfig(original, target)
    for (const path of paths) {
      const content = await readFile(join(target, path), "utf8")
      const parsed = path.endsWith("toml") ? parseClientToml(content) : JSON.parse(content)
      expect(Object.keys(parsed as object)).toEqual([path.endsWith("toml") ? "mcp_servers" : "mcpServers"])
      expect(content).toContain(fixtureSecret)
      expect(content).not.toContain("approval_policy")
      expect(content).not.toContain("operator-model")
      expect(content).not.toContain("trust_level")
      expect((await lstat(join(target, path))).mode & 0o777).toBe(0o600)
    }
    expect(await parallelGit(target, ["status", "--porcelain"])).toBe("")
    expect((await parallelGit(target, ["check-ignore", ...paths])).trim().split("\n")).toEqual(paths)
    await parallelGit(target, ["add", "-A"])
    expect(await parallelGit(target, ["diff", "--cached", "--name-only"])).toBe("")
    const snapshot = await captureParallelBaseline(target)
    const names = await parallelGit(target, ["ls-tree", "-r", "--name-only", snapshot.tree])
    for (const path of paths) expect(names.split("\n")).not.toContain(path)
    expect(await readFile(join(original, ".git", "index"))).toEqual(sourceIndex)
    expect(await parallelGit(original, ["show-ref"])).toBe(sourceRefs)
    expect(await readFile(join(original, ".gitignore"))).toEqual(ignore)
  })

  it("preserves existing tracked target files without overwriting model, approval or MCP settings", async () => {
    await config(original, ".qwen/settings.json", JSON.stringify({ mcpServers: { source: { command: "original" } } }))
    const existing =
      '{"model":"target-model","approval":"target-policy","mcpServers":{"target":{"command":"existing"}}}\n'
    await config(target, ".qwen/settings.json", existing)
    await parallelGit(target, ["add", "-f", ".qwen/settings.json"])
    const index = await readFile(join(target, ".git", "index"))
    await prepareChiefToolConfig(original, target)
    expect(await readFile(join(target, ".qwen/settings.json"), "utf8")).toBe(existing)
    expect(await readFile(join(target, ".git", "index"))).toEqual(index)
  })

  it("supports native shared worktrees and is idempotent using private Git info/exclude", async () => {
    await config(original, ".mcp.json", JSON.stringify({ mcpServers: { aside: { command: "aside" } } }))
    await rm(target, { recursive: true })
    await parallelGit(original, ["worktree", "add", "-q", "-b", "mission", target])
    const sourceIndex = await readFile(join(original, ".git", "index"))
    await prepareChiefToolConfig(original, target)
    const exclude = await readFile(join(original, ".git", "info", "exclude"), "utf8")
    const content = await readFile(join(target, ".mcp.json"), "utf8")
    await prepareChiefToolConfig(original, target)
    expect(await readFile(join(target, ".mcp.json"), "utf8")).toBe(content)
    expect(await readFile(join(original, ".git", "info", "exclude"), "utf8")).toBe(exclude)
    expect(exclude).toContain("/.mcp.json\n")
    expect(exclude).toContain("/.mcp.json.av-mcp-*.tmp\n")
    expect(await parallelGit(target, ["status", "--porcelain"])).toBe("")
    expect(await readFile(join(original, ".git", "index"))).toEqual(sourceIndex)
  })

  it("skips model-only configs and avoids Git checks when there is no MCP configuration to copy", async () => {
    await config(original, ".qwen/settings.json", '{"model":"pinned","trust":true}')
    await prepareChiefToolConfig(original, target)
    await expect(lstat(join(target, ".qwen", "settings.json"))).rejects.toMatchObject({ code: "ENOENT" })
    await rm(join(target, ".git"), { recursive: true })
    await prepareChiefToolConfig(original, target)
  })

  it.each([
    [".mcp.json", `{"mcpServers":${fixtureSecret}}`],
    [".codex/config.toml", `[mcp_servers]\nkey = "${fixtureSecret}`],
    [".cursor/mcp.json", `{"mcpServers":["${fixtureSecret}"]}`],
  ])("rejects malformed %s with actionable errors that omit credentials", async (path, content) => {
    await config(original, path, content)
    const error = await prepareChiefToolConfig(original, target).catch((failure: Error) => failure)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("Invalid project MCP configuration")
    expect((error as Error).message).not.toContain(fixtureSecret)
    await expect(lstat(join(target, path))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("bounds source config bytes before reading or writing copies", async () => {
    await config(original, ".mcp.json", "x".repeat(1024 * 1024 + 1))
    await expect(prepareChiefToolConfig(original, target)).rejects.toThrow("1 MiB")
    await expect(lstat(join(target, ".mcp.json"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects source and target symlinks including configuration parent directories", async () => {
    const outside = join(directory, "outside.json")
    await writeFile(outside, JSON.stringify({ mcpServers: { aside: { command: fixtureSecret } } }))
    await symlink(outside, join(original, ".mcp.json"))
    await expect(prepareChiefToolConfig(original, target)).rejects.toThrow("regular files")
    await rm(join(original, ".mcp.json"))
    await config(original, ".cursor/mcp.json", JSON.stringify({ mcpServers: { aside: { command: "aside" } } }))
    await symlink(join(original, ".cursor"), join(target, ".cursor"))
    await expect(prepareChiefToolConfig(original, target)).rejects.toThrow("local directories")
    await rm(join(target, ".cursor"))
    await config(target, ".cursor/mcp.json", "{}")
    await rm(join(target, ".cursor", "mcp.json"))
    await symlink(outside, join(target, ".cursor", "mcp.json"))
    await expect(prepareChiefToolConfig(original, target)).rejects.toThrow("regular files")
  })

  it("rejects redirected Git excludes before copying any credentials", async () => {
    await config(original, ".mcp.json", JSON.stringify({ mcpServers: { aside: { env: { TOKEN: fixtureSecret } } } }))
    const outside = join(directory, "outside-exclude")
    await writeFile(outside, "Original outside content\n")
    await rm(join(target, ".git", "info", "exclude"))
    await symlink(outside, join(target, ".git", "info", "exclude"))
    await expect(prepareChiefToolConfig(original, target)).rejects.toThrow("Git metadata")
    expect(await readFile(outside, "utf8")).toBe("Original outside content\n")
    await expect(lstat(join(target, ".mcp.json"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})
