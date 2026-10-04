# AV native plugins

AV provides a public skills-only plugin and project-bound exports for OpenAI/Codex, Claude, Cursor, Qwen Code, and Antigravity. The public plugin installs instructions for delegating goals. Project-bound exports also include the six mission MCP tools. Both use the installed AV runtime.

## Install from the public repository

Install the [AV runtime](./environment-setup.md), then add the public repository's marketplace in Claude Code:

```bash
claude plugin marketplace add first-fluke/agent-valley
claude plugin install av@agent-valley
```

Codex supports the repository's Claude-compatible catalog and its relative plugin source:

```bash
codex plugin marketplace add first-fluke/agent-valley
```

Install `av` from the `agent-valley` marketplace in the ChatGPT desktop Plugins Directory. See [OpenAI local marketplace support](https://developers.openai.com/plugins/build/plugins) and [Claude repository marketplaces](https://code.claude.com/docs/en/plugin-marketplaces).

In Cursor, import `first-fluke/agent-valley` through its GitHub marketplace flow, then install `av`. The repository includes its native catalog and plugin manifest. See [Cursor plugin formats and catalogs](https://prod.cursor.com/docs/reference/plugins).

Qwen Code can discover the shared Claude-format catalog and install its `av` entry:

```bash
qwen extensions sources add first-fluke/agent-valley
qwen extensions install first-fluke/agent-valley:av
```

See [Qwen marketplace sources](https://qwenlm.github.io/qwen-code-docs/en/users/extension/introduction/#from-claude-code-marketplace). From a checkout of this repository, Qwen can also install `./integrations`. Antigravity's strict native package is available in the same checkout:

```bash
agy plugin install ./integrations/plugins/antigravity/av
```

For agent-led runtime installation and configuration, give the local agent [AGENT_SETUP.md](../../AGENT_SETUP.md) and the repository where AV should work. The user-facing initiating agent becomes the Chief Director and carries its confirmed active model or explicitly saves the native default; an installer worker preserves that identity. Setup saves that choice, prepares OMA, and installs the project's MCP configuration without starting a mission. Restart the client and complete its normal workspace/MCP trust steps; read `av_missions` to check the connection when the tools are available. If AV configuration is in directory A and its target repository is B, setup installs the client entry in B and keeps the server bound to A; see [project binding](./agent-clients.md).

The public catalogs point to `integrations/`, which contains the portable identity, native compatibility manifests, and shared skill. The public packages contain no project-specific MCP command or server URL. They need the project's configured AV MCP server. Installing this plugin does not start a mission or connect a ChatGPT/Claude web account; [web access](./web-mcp.md) requires a running authenticated server and an account connection.

Repository marketplace installation makes the plugin available through this repository. Central OpenAI, Anthropic, Cursor, and Antigravity directories have separate submission and review processes.

The public sources use the repository's [AGPL-3.0 license](../../LICENSE). See [data handling](../../integrations/PRIVACY.md) and [usage terms](../../integrations/TERMS.md). Cursor's [publisher terms](https://cursor.com/marketplace-publisher-terms) exclude AGPL components from its central marketplace, so the current license prevents that listing.

## Export for a configured project

Export packages for your AV project:

```bash
av plugins export --workspace /absolute/av-project --output /absolute/av-plugins
```

The workspace is the directory containing AV configuration and mission history. Its `workspace.root` selects the working repository. Local plugin servers launch `av mcp --workspace /absolute/av-project`, so the client's launch directory cannot silently select another project. Keep `av` on the client's PATH. These local packages are bound to the selected machine/project.

Keep repository-local exports under `.agent-valley/plugin-exports/`, which Git ignores. Public distribution uses the skills-only source above. Generated local exports contain private machine/project bindings and should stay local.

For a shared remote server, export with its complete HTTPS MCP URL:

```bash
av plugins export --workspace /absolute/av-project --output /absolute/av-remote-plugins \
  --remote-url https://av.example.com/mcp
```

Configure the [OAuth gateway](./web-mcp.md) before connecting remote clients. The exported packages contain the server URL, never access tokens, passwords, private keys, or client secrets. An export does not deploy the server, register an OAuth client, or link an account.

<!-- oma-docs:ignore-start -->
<!-- These paths are generated beneath the requested export directory. -->
| Platform | Exported location | Entry files |
|---|---|---|
| OpenAI / Codex | `portable/av` | `plugin.json`, `mcp.json`, `skills/av/SKILL.md` |
| Claude | `claude/plugins/av` | `.claude-plugin/plugin.json`, `.mcp.json`, `skills/av/SKILL.md` |
| Cursor | `cursor/plugins/av` | `.cursor-plugin/plugin.json`, `mcp.json`, `skills/av/SKILL.md` |
| Qwen Code | `qwen/av` | `qwen-extension.json`, `skills/av/SKILL.md` |
| Antigravity | `antigravity/av` | `plugin.json`, `mcp_config.json`, `skills/av/SKILL.md` |
<!-- oma-docs:ignore-end -->

The portable package uses Agent Plugins v1. Claude and Cursor exports include their marketplace catalogs, and the portable export includes a Codex local marketplace catalog. Product source lives in `integrations/`; generated exports do not modify the repository's managed OMA definitions. The exporter refuses unowned files, changed owned files, and symlinks. Re-exporting an unchanged AV-owned package updates it from the product source.

## Install locally

For Claude Code:

```bash
claude plugin marketplace add /absolute/av-plugins/claude
claude plugin install av@agent-valley
```

For development, `claude --plugin-dir /absolute/av-plugins/claude/plugins/av` loads the package directly. See [Claude plugin installation](https://code.claude.com/docs/en/discover-plugins).

For Codex, add the exported marketplace, then install `av` from that marketplace in the plugin directory:

```bash
codex plugin marketplace add /absolute/av-plugins/portable
```

See [OpenAI plugin packaging and local marketplaces](https://developers.openai.com/plugins/build/plugins). A ChatGPT web account uses a connected remote MCP server; it cannot execute a local stdio command simply because a portable package was imported.

For Qwen Code and Antigravity:

```bash
qwen extensions install /absolute/av-plugins/qwen/av
agy plugin install /absolute/av-plugins/antigravity/av
```

See [Qwen extensions](https://qwenlm.github.io/qwen-code-docs/en/users/extension/agent-plugins/) and [Antigravity plugins](https://antigravity.google/docs/plugins).

For Cursor, copy `cursor/plugins/av` into its supported local plugins directory, then reload:

```bash
mkdir -p ~/.cursor/plugins/local
cp -R /absolute/av-plugins/cursor/plugins/av ~/.cursor/plugins/local/av
```

Use an empty destination; reconcile an existing AV plugin before replacing it. Your workspace policy must permit local plugin imports. See [Cursor local plugin testing](https://prod.cursor.com/docs/plugins#test-plugins-locally).

Cursor's exported catalog and manifest follow its [native plugin format](https://prod.cursor.com/docs/reference/plugins). Its GitHub import accepts a repository containing the exported Cursor marketplace catalog. Use a remote export for a repository intended for other users. For an existing local project, `av integrations install --workspace /absolute/repository --project-root /absolute/av-project` installs the Cursor skill and MCP entry directly without requiring marketplace distribution.

Restart/reload the client and complete its normal plugin, workspace, and MCP trust steps. If project integration and a native plugin both expose AV tools, select one for the project to avoid duplicate server entries. Installation does not enable trust or change approval settings.

## Web plugins and publication

ChatGPT and Claude web need access to the configured remote server and an account connection. Follow [web MCP setup](./web-mcp.md), then import the package through the host's supported custom plugin flow. For Claude web, use a remote package and its custom plugin upload flow; a local MCP connection is for supported local execution surfaces. See [Claude plugin uploads](https://support.claude.com/en/articles/13837440-use-plugins-in-claude).

The exporter prepares manifests and catalogs. It does not submit a marketplace listing, obtain provider review, or connect any real user account. Local exports and temporary integration tests establish package structure and AV behavior; provider installation and real account connections require validation in those hosts.
