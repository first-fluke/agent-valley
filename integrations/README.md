# Agent Valley integration sources

`skills/av/SKILL.md` is the shared client instruction source. `plugin.json` contains the portable plugin identity and metadata. The public plugin is skills-only. Its native Claude/Cursor manifests and Qwen compatibility manifest use the same skill directory. `plugins/antigravity/av` supplies Antigravity's strict native manifest and a byte-identical skill copy; the packaging tests check it against the shared source.

The repository's `.claude-plugin/marketplace.json` and `.cursor-plugin/marketplace.json` point to this directory. Codex supports the shared Claude-compatible catalog and its plain-string relative source; the repository's managed `.agents` definitions are unchanged. See [OpenAI marketplace compatibility](https://developers.openai.com/plugins/build/plugins).

See [data handling](./PRIVACY.md) and [usage terms](./TERMS.md) for the public package. Its software license is [AGPL-3.0](../LICENSE).

Public repository installation:

```bash
claude plugin marketplace add first-fluke/agent-valley
claude plugin install av@agent-valley
codex plugin marketplace add first-fluke/agent-valley
qwen extensions sources add first-fluke/agent-valley
qwen extensions install first-fluke/agent-valley:av
```

Install `av` from the `agent-valley` marketplace in the ChatGPT desktop Plugins Directory after adding it with Codex. Cursor imports the repository through its GitHub marketplace flow. From a checkout, Antigravity installs `./integrations/plugins/antigravity/av` with `agy plugin install`.

Install the AV runtime, then run `av setup` from the intended project to configure the Chief Director and prepare that project's MCP entry. Public packages include no MCP command, private workspace path, credential, or endpoint. The shared skill uses the project's configured AV tools. Installing the public plugin does not host AV, connect a web account, or submit a central marketplace listing. See [native plugin installation](../docs/guides/native-plugins.md).

## Project-bound exports

The CLI copies these sources into complete vendor packages. Generated copies do not become new sources. Keep repository-local exports in `.agent-valley/plugin-exports/`, which Git ignores, and exclude machine-specific exports from public distribution.

Export plugins bound to an existing AV configuration directory:

```bash
av plugins export --workspace /absolute/project --output /absolute/av-plugins
```

For an authenticated web endpoint, export HTTP configurations instead of local commands:

```bash
av plugins export --workspace /absolute/project --output /absolute/av-web-plugins --remote-url https://your-host/mcp
```

The export contains portable Agent Plugins v1 files and an OpenAI local marketplace, native Claude and Cursor manifests and marketplaces, a Qwen extension, and an Antigravity plugin. Each package includes the shared AV skill and its MCP server configuration. Local servers receive an absolute `--workspace` argument; moving a package or changing the client's working directory does not change the selected AV project. Regenerate the export after moving that project.

Use the generated `README.md` for client installation commands. Exports preserve unowned files and local edits; choose a new output directory when an existing export conflicts. Exporting does not install into user profiles, publish a marketplace, or host the web server. See [native plugins](../docs/guides/native-plugins.md) and [web MCP](../docs/guides/web-mcp.md).
