import { constants } from "node:fs"
import { access, lstat, readFile, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, isAbsolute, join, resolve } from "node:path"
import { parseClientToml } from "./client-toml"

export interface ToolAvailability {
  id: string
  name: string
  kind: "cli" | "mcp"
  availability: "available" | "configured" | "unavailable" | "invalid"
  authentication: "unknown"
  scope: "project" | "user"
  source?: string
  reason?: string
}

const binaries = [
  "docker",
  "orb",
  "orbstack",
  "kubectl",
  "aws",
  "gcloud",
  "az",
  "wrangler",
  "cloudflared",
  "sentry-cli",
]
const MAX_CONFIG_BYTES = 1_048_576
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

async function executable(name: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  for (const directory of (env.PATH ?? "").split(delimiter).filter(isAbsolute)) {
    try {
      const path = join(directory, name)
      await access(path, constants.X_OK)
      if ((await lstat(await realpath(path))).isFile()) return true
    } catch {
      // Discovery never runs a CLI or changes its login state.
    }
  }
  return false
}

async function mcpNames(
  path: string,
  scope: "project" | "user",
  project: string,
  requestedRoot: string,
): Promise<ToolAvailability[]> {
  const base = { kind: "mcp" as const, scope, authentication: "unknown" as const, source: path }
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONFIG_BYTES) throw new Error("Invalid config")
    const source = await readFile(path, "utf8")
    if (Buffer.byteLength(source) > MAX_CONFIG_BYTES) throw new Error("Invalid config")
    const config = record(path.endsWith(".toml") ? parseClientToml(source) : JSON.parse(source))
    const configured = {
      ...record(config.mcp_servers),
      ...record(config.mcpServers),
      ...record(config.servers),
      ...record(record(record(config.projects)[requestedRoot]).mcpServers),
      ...record(record(record(config.projects)[project]).mcpServers),
    }
    return Object.entries(configured)
      .slice(0, 100)
      .map(([name, value]) => {
        const server = record(value)
        const valid = /^[\p{L}\p{N}_.-]{1,120}$/u.test(name) && Object.keys(server).length > 0
        const safeName = valid ? name : "invalid-server"
        const disabled = server.disabled === true || server.enabled === false
        return {
          ...base,
          id: `mcp:${scope}:${safeName}`,
          name: safeName,
          availability: !valid ? "invalid" : disabled ? "unavailable" : "configured",
          reason: !valid
            ? "Invalid MCP server entry; inspect its client configuration."
            : disabled
              ? "Disabled in client configuration."
              : "Client configuration found; connectivity, login and availability in the Actor workspace are unverified.",
        }
      })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    // Parser error messages can include credential-bearing source lines.
    return [
      {
        ...base,
        id: `mcp-config:${scope}:${path}`,
        name: "MCP configuration",
        availability: "invalid",
        reason: "MCP configuration is unreadable, malformed, oversized or a symlink. Inspect the named file.",
      },
    ]
  }
}

/** Metadata only. No authentication probes, environment values or configured commands are returned. */
export async function discoverTools(
  root: string,
  dependencies: { env?: NodeJS.ProcessEnv; home?: string } = {},
): Promise<ToolAvailability[]> {
  const env = dependencies.env ?? process.env
  const home = dependencies.home ?? homedir()
  const project = await realpath(root)
  const projectFiles = [
    ".mcp.json",
    ".cursor/mcp.json",
    ".qwen/settings.json",
    ".gemini/settings.json",
    ".vscode/mcp.json",
    ".codex/config.toml",
  ]
  const userFiles = [".claude.json", ".cursor/mcp.json", ".qwen/settings.json", ".gemini/settings.json"]
  const codexHome = env.CODEX_HOME && isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : join(home, ".codex")
  const configs = [
    ...projectFiles.map((path) => ({ path: join(project, path), scope: "project" as const })),
    ...userFiles.map((path) => ({ path: resolve(home, path), scope: "user" as const })),
    { path: join(codexHome, "config.toml"), scope: "user" as const },
  ]
  const [cli, mcp] = await Promise.all([
    Promise.all(
      binaries.map(
        async (name): Promise<ToolAvailability> => ({
          id: `cli:${name}`,
          name,
          kind: "cli",
          scope: "user",
          authentication: "unknown",
          availability: (await executable(name, env)) ? "available" : "unavailable",
          reason: "Executable presence only; service access, daemon state and login are unverified.",
        }),
      ),
    ),
    Promise.all(configs.map(({ path, scope }) => mcpNames(path, scope, project, resolve(root)))),
  ])
  return [...cli, ...mcp.flat()]
}
