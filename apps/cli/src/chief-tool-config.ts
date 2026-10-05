import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises"
import { join } from "node:path"
import { parallelGit } from "@agent-valley/core/chief/parallel-git"
import { stringify } from "smol-toml"
import { parseClientToml } from "./client-toml"

const maximumBytes = 1024 * 1024
class ChiefToolConfigError extends Error {}
const configFiles = [
  { path: ".mcp.json", namespace: "mcpServers", toml: false },
  { path: ".cursor/mcp.json", namespace: "mcpServers", toml: false },
  { path: ".qwen/settings.json", namespace: "mcpServers", toml: false },
  { path: ".gemini/settings.json", namespace: "mcpServers", toml: false },
  { path: ".codex/config.toml", namespace: "mcp_servers", toml: true },
] as const

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

async function assertLocalPath(root: string, local: string): Promise<boolean> {
  const parts = local.split("/")
  let current = root
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    const stats = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!stats) return false
    if (stats.isSymbolicLink() || (index < parts.length - 1 ? !stats.isDirectory() : !stats.isFile()))
      throw new ChiefToolConfigError(
        `MCP configuration ${local} must use regular files and local directories. Restore its original path before starting Chief.`,
      )
  }
  return true
}

async function readPrivateFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stats = await file.stat()
    if (!stats.isFile() || stats.size > maximumBytes)
      throw new ChiefToolConfigError("MCP configuration must be a regular file smaller than 1 MiB.")
    const content = await file.readFile()
    if (content.length > maximumBytes)
      throw new ChiefToolConfigError("MCP configuration exceeds 1 MiB. Reduce it before starting Chief.")
    return content.toString("utf8")
  } finally {
    await file.close()
  }
}

function selectedNamespace(source: string, namespace: string, toml: boolean): string | undefined {
  try {
    const content: unknown = toml ? parseClientToml(source) : JSON.parse(source)
    if (!plainObject(content)) throw new ChiefToolConfigError("Invalid client configuration")
    if (!Object.hasOwn(content, namespace)) return undefined
    const servers = content[namespace]
    if (!plainObject(servers) || Object.values(servers).some((server) => !plainObject(server)))
      throw new ChiefToolConfigError("Invalid MCP server map")
    if (!Object.keys(servers).length) return undefined
    const value = { [namespace]: servers }
    const result = toml ? stringify(value) : `${JSON.stringify(value, null, 2)}\n`
    if (Buffer.byteLength(result) > maximumBytes)
      throw new ChiefToolConfigError("MCP server map exceeds its output limit")
    return result
  } catch {
    throw new ChiefToolConfigError(
      "Invalid project MCP configuration. Repair its MCP server map using the native client's format; credentials and configuration contents were omitted from this error.",
    )
  }
}

async function privateExclude(original: string, target: string, paths: string[]): Promise<void> {
  const [originalCommon, targetCommon, exclude] = await Promise.all([
    parallelGit(original, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    parallelGit(target, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    parallelGit(target, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]),
  ])
  const common = targetCommon.trim()
  const path = exclude.trim()
  if (
    (common !== join(target, ".git") && common !== originalCommon.trim()) ||
    path !== join(common, "info", "exclude") ||
    (await realpath(common)) !== common
  )
    throw new ChiefToolConfigError(
      "Chief MCP configuration requires the workspace's own Git metadata or its original repository's shared worktree metadata.",
    )
  const info = join(common, "info")
  const infoStats = await lstat(info).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (infoStats && !infoStats.isDirectory())
    throw new ChiefToolConfigError("Git info storage must be a local directory before preparing Chief MCP tools.")
  if (!infoStats) await mkdir(info, { mode: 0o700 })
  if ((await realpath(info)) !== info)
    throw new ChiefToolConfigError(
      "Git info storage redirects through a symlink. Restore it before preparing Chief MCP tools.",
    )
  const exists = await assertLocalPath(common, "info/exclude")
  const content = exists ? await readPrivateFile(path) : ""
  const lines = new Set(content.split(/\r?\n/))
  const patterns = paths
    .flatMap((local) => [`/${local}`, `/${local}.av-mcp-*.tmp`])
    .filter((pattern) => !lines.has(pattern))
  if (!patterns.length) return
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await file.writeFile(`${content && !content.endsWith("\n") ? "\n" : ""}${patterns.join("\n")}\n`)
  } finally {
    await file.close()
  }
}

/** Reuse operator MCP namespaces in isolated workspaces without changing client trust or launching servers. */
async function prepareToolConfig(originalRepository: string, targetWorkspace: string): Promise<void> {
  const [original, target] = await Promise.all([realpath(originalRepository), realpath(targetWorkspace)])
  if (original === target)
    throw new ChiefToolConfigError(
      "Prepare Chief MCP tools in a separate mission workspace using its original repository root.",
    )
  const selected: { path: string; content: string }[] = []
  for (const config of configFiles) {
    if (await assertLocalPath(target, config.path)) continue
    if (!(await assertLocalPath(original, config.path))) continue
    const content = selectedNamespace(await readPrivateFile(join(original, config.path)), config.namespace, config.toml)
    if (content) selected.push({ path: config.path, content })
  }
  if (!selected.length) return
  for (const root of [original, target]) {
    const stats = await lstat(join(root, ".git"))
    if (
      stats.isSymbolicLink() ||
      (!stats.isFile() && !stats.isDirectory()) ||
      (await realpath((await parallelGit(root, ["rev-parse", "--show-toplevel"])).trim())) !== root
    )
      throw new ChiefToolConfigError(
        "Chief MCP tools require original local Git repository metadata. Restore the workspace before starting Chief.",
      )
  }
  await privateExclude(
    original,
    target,
    selected.map((config) => config.path),
  )
  for (const config of selected) {
    const parts = config.path.split("/")
    if (parts.length > 1) {
      const parent = join(target, ...parts.slice(0, -1))
      await mkdir(parent, { recursive: true, mode: 0o700 })
      if ((await realpath(parent)) !== parent)
        throw new ChiefToolConfigError(
          "Chief MCP configuration parent redirects through a symlink. Restore its local directory.",
        )
    }
    if (await assertLocalPath(target, config.path)) continue
    const path = join(target, config.path)
    const temporary = `${path}.av-mcp-${randomUUID()}.tmp`
    const file = await open(temporary, "wx", 0o600)
    try {
      await file.writeFile(config.content)
    } finally {
      await file.close()
    }
    try {
      await link(temporary, path).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error
        await assertLocalPath(target, config.path)
      })
    } finally {
      await unlink(temporary)
    }
  }
}

export async function prepareChiefToolConfig(originalRepository: string, targetWorkspace: string): Promise<void> {
  try {
    await prepareToolConfig(originalRepository, targetWorkspace)
  } catch (error) {
    if (error instanceof ChiefToolConfigError) throw error
    throw new ChiefToolConfigError(
      "Cannot prepare Chief MCP configuration. Restore local regular config files and Git metadata, then retry; configuration contents were omitted from this error.",
    )
  }
}
