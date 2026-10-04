import { lstat, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parse as parseToml } from "smol-toml"
import { clientSkillAssetCandidates, loadClientSkillAsset } from "./client-integrations-assets"
import { jsonMcpFile, type ParseToml, tomlMcpFile } from "./client-integrations-config"
import {
  applyIntegrationFiles,
  contentHash,
  type IntegrationFile,
  integrationConflict,
  integrationFile,
  safeIntegrationPath,
} from "./client-integrations-files"

export const integrationClients = ["codex", "claude", "qwen", "cursor", "antigravity"] as const
export type IntegrationClient = (typeof integrationClients)[number]
export const clientSkillDirectories: Record<IntegrationClient, string> = {
  codex: ".agents/skills/av",
  claude: ".claude/skills/av",
  qwen: ".qwen/skills/av",
  cursor: ".cursor/skills/av",
  antigravity: ".agents/skills/av",
}

export interface ClientIntegrationOptions {
  projectRoot?: string
  sourceSkillRoot?: string
  parseToml?: ParseToml
}

export interface ClientIntegrationResult {
  workspaceRoot: string
  projectRoot: string
  clients: IntegrationClient[]
  files: string[]
}

const owner = "agent-valley/client-skill"
const receiptName = ".av-install.json"

async function skillFiles(root: string, relativeDirectory: string, skill: string): Promise<IntegrationFile[]> {
  const directory = join(root, relativeDirectory)
  await safeIntegrationPath(root, directory)
  let exists = false
  try {
    if (!(await lstat(directory)).isDirectory()) throw integrationConflict(directory, "expected a skill directory")
    exists = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const markdown = await integrationFile(root, join(directory, "SKILL.md"), skill, 0o644)
  const receipt = await integrationFile(root, join(directory, receiptName), "", 0o644)
  if (exists) {
    let previous: unknown
    try {
      previous = JSON.parse(receipt.before ?? "")
    } catch {
      throw integrationConflict(directory, "the existing av skill is unowned; no files were replaced")
    }
    const saved = previous as { owner?: unknown; version?: unknown; skillSha256?: unknown }
    if (
      previous === null ||
      typeof previous !== "object" ||
      saved.owner !== owner ||
      saved.version !== 1 ||
      typeof saved.skillSha256 !== "string"
    ) {
      throw integrationConflict(directory, "the existing av skill has no valid AV ownership receipt")
    }
    if (markdown.before === null || contentHash(markdown.before) !== saved.skillSha256) {
      throw integrationConflict(markdown.path, "the installed AV skill was changed locally; your edits were retained")
    }
  }
  receipt.after = `${JSON.stringify({ owner, version: 1, skillSha256: contentHash(skill) }, null, 2)}\n`
  return [markdown, receipt]
}

export function parseClientToml(source: string): unknown {
  return parseToml(source, { integersAsBigInt: "asNeeded" })
}

export async function installClientIntegrations(
  workspaceRoot: string,
  options: ClientIntegrationOptions = {},
): Promise<ClientIntegrationResult> {
  let root: string
  try {
    root = await realpath(resolve(workspaceRoot))
    if (!(await lstat(root)).isDirectory()) throw new Error("not a directory")
  } catch {
    throw new Error(
      `workspace.root: ${workspaceRoot} is not an existing repository directory. Set workspace.root in av.yaml or pass av integrations install --workspace /absolute/project.`,
    )
  }
  let projectRoot = root
  if (options.projectRoot !== undefined) {
    try {
      projectRoot = await realpath(resolve(options.projectRoot))
      if (!(await lstat(projectRoot)).isDirectory()) throw new Error("not a directory")
    } catch {
      throw new Error(
        `projectRoot: ${options.projectRoot} is not an existing AV configuration directory. Run setup from the directory containing av.yaml or pass its absolute directory as projectRoot when installing client integrations.`,
      )
    }
  }
  const candidates = options.sourceSkillRoot
    ? [join(options.sourceSkillRoot, "SKILL.md")]
    : clientSkillAssetCandidates(import.meta.url)
  const { content: skill } = await loadClientSkillAsset(candidates)
  const entry = { command: "av", args: ["mcp", "--workspace", projectRoot] }
  const files: IntegrationFile[] = []
  // Preflight every client before mutating any configuration or skill.
  // Codex and Antigravity share the same physical skill directory and receipt.
  for (const directory of new Set(integrationClients.map((client) => clientSkillDirectories[client])))
    files.push(...(await skillFiles(root, directory, skill)))
  files.push(await tomlMcpFile(root, join(root, ".codex/config.toml"), entry, options.parseToml ?? parseClientToml))
  files.push(await jsonMcpFile(root, join(root, ".mcp.json"), entry, "stdio"))
  files.push(await jsonMcpFile(root, join(root, ".qwen/settings.json"), entry))
  files.push(await jsonMcpFile(root, join(root, ".cursor/mcp.json"), entry))
  files.push(await jsonMcpFile(root, join(root, ".agents/mcp_config.json"), entry))
  return {
    workspaceRoot: root,
    projectRoot,
    clients: [...integrationClients],
    files: await applyIntegrationFiles(root, files),
  }
}

export async function installClientIntegrationsCommand(
  options: { workspace?: string; projectRoot?: string } = {},
): Promise<void> {
  const result = await installClientIntegrations(options.workspace ?? process.cwd(), {
    projectRoot: options.projectRoot,
  })
  console.log(
    `AV skills and MCP configuration installed for Codex, Claude Code, Qwen Code, Cursor, and Antigravity in ${result.workspaceRoot}.`,
  )
  if (result.projectRoot !== result.workspaceRoot)
    console.log(`The AV MCP server reads configuration and mission state from ${result.projectRoot}.`)
  console.log(
    "Restart the client, trust the repository and approve its AV MCP server when prompted. Installation does not verify the client connection or run a mission.",
  )
}
