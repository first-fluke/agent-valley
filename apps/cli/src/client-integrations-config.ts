import { type IntegrationFile, integrationConflict, integrationFile } from "./client-integrations-files"

export interface ClientMcpEntry {
  command: string
  args: string[]
}

export type ParseToml = (source: string) => unknown
export const mcpBlockStart = "# Agent Valley MCP: START"
export const mcpBlockEnd = "# Agent Valley MCP: END"

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function expectedEntry(value: unknown, expected: ClientMcpEntry): boolean {
  if (
    !object(value) ||
    value.command !== expected.command ||
    value.url !== undefined ||
    value.httpUrl !== undefined ||
    value.serverUrl !== undefined
  )
    return false
  return (
    Array.isArray(value.args) &&
    value.args.length === expected.args.length &&
    value.args.every((arg, i) => arg === expected.args[i]) &&
    (value.type === undefined || value.type === "stdio")
  )
}

export async function jsonMcpFile(
  root: string,
  path: string,
  entry: ClientMcpEntry,
  type?: "stdio",
): Promise<IntegrationFile> {
  const file = await integrationFile(root, path, "")
  let config: unknown
  try {
    config = file.before === null ? {} : JSON.parse(file.before)
  } catch {
    throw integrationConflict(path, "invalid JSON; repair the existing settings without removing other entries")
  }
  if (!object(config)) throw integrationConflict(path, "settings must be a JSON object")
  const servers = config.mcpServers === undefined ? {} : config.mcpServers
  if (!object(servers)) throw integrationConflict(path, "mcpServers must be an object")
  if (Object.hasOwn(servers, "av")) {
    if (!expectedEntry(servers.av, entry))
      throw integrationConflict(path, "mcpServers.av already belongs to a different server or workspace")
    return { ...file, after: file.before as string }
  }
  const installed = type ? { type, ...entry } : entry
  const after = `${JSON.stringify({ ...config, mcpServers: { ...servers, av: installed } }, null, 2)}\n`
  return { ...file, after }
}

export async function tomlMcpFile(
  root: string,
  path: string,
  entry: ClientMcpEntry,
  parse: ParseToml,
): Promise<IntegrationFile> {
  const file = await integrationFile(root, path, "")
  const source = file.before ?? ""
  let config: unknown
  try {
    config = parse(source)
  } catch {
    throw integrationConflict(path, "invalid TOML; repair the existing configuration")
  }
  if (!object(config)) throw integrationConflict(path, "configuration must be a TOML table")
  const servers = config.mcp_servers ?? {}
  if (!object(servers)) throw integrationConflict(path, "mcp_servers must be a table")
  if (Object.hasOwn(servers, "av")) {
    if (!expectedEntry(servers.av, entry))
      throw integrationConflict(path, "mcp_servers.av already belongs to a different server or workspace")
    return { ...file, after: source }
  }
  if (source.includes(mcpBlockStart) || source.includes(mcpBlockEnd))
    throw integrationConflict(path, "an incomplete managed AV MCP block exists")
  const block = `${mcpBlockStart}\n[mcp_servers.av]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n${mcpBlockEnd}\n`
  const after = `${source}${source && !source.endsWith("\n") ? "\n" : ""}${source ? "\n" : ""}${block}`
  try {
    const result = parse(after)
    if (!object(result) || !object(result.mcp_servers) || !expectedEntry(result.mcp_servers.av, entry))
      throw new Error("unexpected server table")
  } catch {
    throw integrationConflict(
      path,
      "AV cannot append its MCP table without changing existing TOML; add the server manually",
    )
  }
  return { ...file, after }
}
