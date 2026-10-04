import type { Dirent } from "node:fs"
import { lstat, readdir, realpath } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { clientSkillAssetCandidates, loadClientSkillAsset } from "./client-integrations-assets"
import { applyIntegrationFiles, contentHash, integrationFile } from "./client-integrations-files"
import { loadPluginLicenseAsset, loadPluginManifestAsset } from "./plugin-assets"
import { pluginPackageFiles } from "./plugin-packages"

const receiptName = ".agent-valley-plugins.json"
const receiptOwner = "agent-valley.plugins"

export interface PluginExportOptions {
  workspace: string
  output: string
  remoteUrl?: string
  sourceSkillRoot?: string
  sourceManifest?: string
  sourceLicense?: string
}

export interface PluginExportResult {
  workspace: string
  output: string
  transport: "stdio" | "streamable-http"
  files: string[]
  packages: Record<"portable" | "claude" | "cursor" | "qwen" | "antigravity", string>
}

function exportConflict(path: string, reason: string): Error {
  return new Error(
    `${path}: ${reason}. Keep the existing export and rerun av plugins export with a new --output directory.`,
  )
}

async function projectDirectory(workspace: string): Promise<string> {
  if (typeof workspace !== "string" || !workspace.trim())
    throw new Error("Pass --workspace /absolute/AV-project to bind every exported MCP server to its AV configuration.")
  try {
    const project = await realpath(resolve(workspace))
    if (!(await lstat(project)).isDirectory()) throw new Error("not a directory")
    return project
  } catch {
    throw new Error(
      `workspace.root: ${workspace} is not an existing project directory. Pass --workspace /absolute/AV-project containing av.yaml.`,
    )
  }
}

function remoteEndpoint(value?: string): string | undefined {
  if (value === undefined) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/mcp")
      throw new Error("invalid endpoint")
    return url.href
  } catch {
    throw new Error(
      "Set --remote-url to an authenticated HTTPS /mcp endpoint without credentials, query parameters, or a fragment. Configure OAuth on av mcp --http; keep tokens outside plugin files.",
    )
  }
}

async function outputDirectory(output: string): Promise<string> {
  if (typeof output !== "string" || !output.trim())
    throw new Error("Pass --output /absolute/export-directory to write the generated AV plugin packages.")
  const target = resolve(output)
  let ancestor = target
  for (;;) {
    try {
      const info = await lstat(ancestor)
      if (info.isSymbolicLink()) throw exportConflict(ancestor, "symbolic link exports are not modified")
      if (!info.isDirectory()) throw exportConflict(ancestor, "expected an output directory")
      return join(await realpath(ancestor), relative(ancestor, target))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      ancestor = dirname(ancestor)
    }
  }
}

async function outputFiles(root: string, directory = root): Promise<string[]> {
  let entries: Dirent<string>[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw exportConflict(path, "symbolic links are not modified")
    if (entry.isDirectory()) files.push(...(await outputFiles(root, path)))
    else if (entry.isFile()) files.push(relative(root, path).split("\\").join("/"))
    else throw exportConflict(path, "expected regular export files")
  }
  return files
}

function ownedFileHashes(content: string | null, path: string): Record<string, string> {
  if (content === null) return {}
  try {
    const value: unknown = JSON.parse(content)
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid receipt")
    const receipt = value as { owner?: unknown; version?: unknown; files?: unknown }
    if (
      receipt.owner !== receiptOwner ||
      receipt.version !== 1 ||
      !receipt.files ||
      typeof receipt.files !== "object" ||
      Array.isArray(receipt.files)
    )
      throw new Error("invalid receipt")
    const hashes = receipt.files as Record<string, unknown>
    if (!Object.values(hashes).every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)))
      throw new Error("invalid receipt")
    return hashes as Record<string, string>
  } catch {
    throw exportConflict(path, "the export has no valid AV ownership receipt")
  }
}

export async function exportPluginPackages(options: PluginExportOptions): Promise<PluginExportResult> {
  const workspace = await projectDirectory(options.workspace)
  const remoteUrl = remoteEndpoint(options.remoteUrl)
  const output = await outputDirectory(options.output)
  if (output === workspace)
    throw exportConflict(output, "the output directory must be separate from the AV project root")
  const { manifest } = await loadPluginManifestAsset(options.sourceManifest ? [options.sourceManifest] : undefined)
  const { content: skill } = await loadClientSkillAsset(
    options.sourceSkillRoot ? [join(options.sourceSkillRoot, "SKILL.md")] : clientSkillAssetCandidates(),
  )
  const { content: license } = await loadPluginLicenseAsset(options.sourceLicense ? [options.sourceLicense] : undefined)
  const packageFiles = pluginPackageFiles(manifest, skill, license, { workspace, remoteUrl })
  const receipt = await integrationFile(output, join(output, receiptName), "", 0o600)
  const hashes = ownedFileHashes(receipt.before, receipt.path)
  const existing = await outputFiles(output)
  for (const path of existing) {
    if (path === receiptName) continue
    if (!packageFiles.has(path) || hashes[path] === undefined)
      throw exportConflict(join(output, path), "unowned files are retained")
  }
  const files = []
  for (const [path, content] of packageFiles) {
    const file = await integrationFile(output, join(output, path), content, 0o644)
    if (hashes[path] !== undefined && (file.before === null || contentHash(file.before) !== hashes[path]))
      throw exportConflict(file.path, "the exported file was changed or removed locally")
    if (hashes[path] === undefined && file.before !== null)
      throw exportConflict(file.path, "unowned files are retained")
    files.push(file)
  }
  receipt.after = `${JSON.stringify(
    {
      owner: receiptOwner,
      version: 1,
      files: Object.fromEntries([...packageFiles].map(([path, content]) => [path, contentHash(content)])),
    },
    null,
    2,
  )}\n`
  return {
    workspace,
    output,
    transport: remoteUrl ? "streamable-http" : "stdio",
    files: await applyIntegrationFiles(output, [...files, receipt]),
    packages: {
      portable: join(output, "portable/av"),
      claude: join(output, "claude/plugins/av"),
      cursor: join(output, "cursor/plugins/av"),
      qwen: join(output, "qwen/av"),
      antigravity: join(output, "antigravity/av"),
    },
  }
}
