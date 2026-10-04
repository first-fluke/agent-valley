import { type PluginManifest, pluginMcpSchemaUrl } from "./plugin-assets"

export interface PluginPackageBinding {
  workspace: string
  remoteUrl?: string
}

export function pluginPackageFiles(
  manifest: PluginManifest,
  skill: string,
  license: string,
  binding: PluginPackageBinding,
): Map<string, string> {
  const files = new Map<string, string>()
  const json = (path: string, value: unknown) => files.set(path, `${JSON.stringify(value, null, 2)}\n`)
  const { $schema: _schema, ...native } = manifest
  const local = { command: "av", args: ["mcp", "--workspace", binding.workspace] }
  const portableServer = binding.remoteUrl
    ? { type: "streamable-http", url: binding.remoteUrl }
    : { type: "stdio", ...local }
  const claudeServer = binding.remoteUrl ? { type: "http", url: binding.remoteUrl } : { type: "stdio", ...local }
  const cursorServer = binding.remoteUrl ? { url: binding.remoteUrl } : local
  const qwenServer = binding.remoteUrl ? { httpUrl: binding.remoteUrl } : local
  const agyServer = binding.remoteUrl ? { serverUrl: binding.remoteUrl } : local
  const roots = ["portable/av", "claude/plugins/av", "cursor/plugins/av", "qwen/av", "antigravity/av"]
  for (const root of roots) {
    files.set(`${root}/skills/av/SKILL.md`, skill)
    files.set(`${root}/LICENSE`, license)
  }

  json("portable/av/plugin.json", {
    ...manifest,
    extensions: {
      "com.openai": {
        interface: {
          displayName: "Agent Valley",
          shortDescription: "Complete repository missions",
          longDescription: manifest.description,
          developerName: manifest.author.name,
          category: "Productivity",
          capabilities: ["Delegate repository goals", "Review mission evidence"],
          defaultPrompt: ["Use Agent Valley to complete the repository goal and report its verification evidence."],
        },
      },
    },
  })
  json("portable/av/mcp.json", { $schema: pluginMcpSchemaUrl, mcpServers: { av: portableServer } })
  json("portable/.agents/plugins/marketplace.json", {
    name: "agent-valley",
    interface: { displayName: "Agent Valley" },
    plugins: [
      {
        name: manifest.name,
        source: { source: "local", path: "./av" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      },
    ],
  })

  json("claude/plugins/av/.claude-plugin/plugin.json", native)
  json("claude/plugins/av/.mcp.json", { mcpServers: { av: claudeServer } })
  json("cursor/plugins/av/.cursor-plugin/plugin.json", { ...native, skills: "./skills/", mcpServers: "./mcp.json" })
  json("cursor/plugins/av/mcp.json", { mcpServers: { av: cursorServer } })
  for (const vendor of ["claude", "cursor"]) {
    json(`${vendor}/.${vendor}-plugin/marketplace.json`, {
      name: "agent-valley",
      owner: manifest.author,
      metadata: { description: manifest.description, version: manifest.version },
      plugins: [{ name: manifest.name, source: "./plugins/av", description: manifest.description }],
    })
  }

  json("qwen/av/qwen-extension.json", {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    skills: "skills",
    mcpServers: { av: qwenServer },
  })
  json("antigravity/av/plugin.json", { name: manifest.name, description: manifest.description })
  json("antigravity/av/mcp_config.json", { mcpServers: { av: agyServer } })
  files.set("README.md", pluginExportReadme(binding))
  return files
}

function pluginExportReadme(binding: PluginPackageBinding): string {
  return `# Agent Valley plugins

${binding.remoteUrl ? `The MCP server uses ${binding.remoteUrl}. Complete the server's OAuth sign-in in the client.` : `Every local MCP server launches \`av mcp --workspace ${binding.workspace}\`. Install the AV CLI on the client's PATH. The selected project remains fixed when the client launches from another directory.`}

Install one package for each client:

- Claude Code: run \`claude plugin marketplace add /absolute/export/claude\`, then \`claude plugin install av@agent-valley\`. For a temporary session, use \`claude --plugin-dir /absolute/export/claude/plugins/av\`.
- Codex: run \`codex plugin marketplace add /absolute/export/portable\`; install Agent Valley from that marketplace in the ChatGPT desktop Plugins Directory. Supported local clients can also use the repo marketplace in \`portable/.agents/plugins/marketplace.json\`.
- Cursor: copy the complete \`cursor/plugins/av\` directory to \`~/.cursor/plugins/local/av\`, then reload Cursor. A repository containing the exported \`cursor\` directory can be added through the native marketplace interface after it is published.
- Qwen Code: run \`qwen extensions install /absolute/export/qwen/av\`. Qwen also accepts the portable \`portable/av\` package.
- Antigravity: run \`agy plugin install /absolute/export/antigravity/av\`.

Replace \`/absolute/export\` with this export's directory. Complete each client's usual plugin, workspace, and MCP trust steps. Local paths are machine-specific; regenerate this export when the AV project moves. Do not publish local exports containing private repository paths.

For Claude web or ChatGPT web, use an export made with \`--remote-url https://your-host/mcp\` and register the authenticated HTTPS server in the client's plugin/developer interface. Web clients cannot start the local stdio command. A directory or marketplace export does not publish a plugin or configure its hosting.

The skill is copied from the AV integration source. Rerunning \`av plugins export\` updates owned files only; locally edited or unowned exports require a new output directory.
`
}
