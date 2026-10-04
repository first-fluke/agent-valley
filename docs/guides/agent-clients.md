# Use AV from an agent client

Codex, Claude Code, Cursor, Qwen Code, and Antigravity can delegate a repository goal to AV through the project `av` skill and a local stdio MCP server. The client submits the goal; AV's Chief Director supervises Actors, reviews the work, runs checks, and saves the mission and report. [Native plugins](./native-plugins.md) package the same skill and tools. [Web MCP](./web-mcp.md) connects ChatGPT or Claude to a running AV server through OAuth.

For an authorized agent-led installation, follow [AGENT_SETUP.md](../../AGENT_SETUP.md). The user-facing initiating agent becomes the Chief Director, prepares OMA and project MCP, and checks setup readiness without a mission. It carries its confirmed active model or explicitly saves the native default when the exact model is unknown; an installer worker preserves that identity. Login and client reload/trust may remain pending.

After AV configuration is ready, prepare or repair the client integration:

```bash
cd /absolute/project
av integrations install
# Or target a repository from another directory:
av integrations install --workspace /absolute/project
```

The source installer's deferred-setup path runs this integration step before the setup wizard. `av setup`, including `--yes`, installs the integration after saving the selected repository's configuration. The command copies the product skill from `integrations/skills/av/SKILL.md` and adds only the `av` MCP entry to each client:

<!-- oma-docs:ignore-start -->
<!-- The following paths are installation outputs in the user's target repository. -->
| Client | Project skill | Project MCP configuration |
|---|---|---|
| Codex | `.agents/skills/av/SKILL.md` | `.codex/config.toml` |
| Claude Code | `.claude/skills/av/SKILL.md` | `.mcp.json` |
| Qwen Code | `.qwen/skills/av/SKILL.md` | `.qwen/settings.json` |
| Cursor | `.cursor/skills/av/SKILL.md` | `.cursor/mcp.json` |
| Antigravity | `.agents/skills/av/SKILL.md` | `.agents/mcp_config.json` |
<!-- oma-docs:ignore-end -->

Each server starts `av mcp --workspace /absolute/project`. For `av mcp`, `--workspace` selects the AV project/configuration directory containing `av.yaml` and saved mission state. Work runs in its configured `workspace.root`; the server advertises that actual target, and an explicit `av_order.workspace` must match it. For `av integrations install`, `--workspace` selects the repository where client skills and MCP settings are installed. Usually these directories are the same.

If configuration lives in directory A and `workspace.root` points to repository B, run `av setup` from A and select B. Setup installs client skills/configurations in B while the saved server entry uses `av mcp --workspace A`, preserving A's AV settings and mission history. Start the agent client in B. To install that integration manually:

```bash
av integrations install --workspace /repository/B --project-root /configuration/A
```

Keep `av` on the client's PATH; a desktop client may inherit a different PATH from your terminal. The saved AV configuration supplies the Chief Director vendor/model, Actors, verification, budgets, metric sources, and optional reporting. Client login, trust, and approval settings remain under your control.

Restart or reload the client after installing. Codex discovers repository skills from `.agents/skills` and loads project configuration only for a trusted project; its stdio MCP table uses `mcp_servers`, `command`, and `args`. See [Codex skills](https://developers.openai.com/codex/skills), [MCP](https://developers.openai.com/codex/mcp), and [project configuration](https://developers.openai.com/codex/config-basic). Claude Code reads project servers from `.mcp.json` and normally asks you to approve them in interactive sessions; check its `/mcp` view. See [Claude Code MCP](https://code.claude.com/docs/en/mcp). Qwen Code reads project `mcpServers` entries from `.qwen/settings.json`; restart it and inspect `/mcp`. See [Qwen Code MCP](https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/).

To check a live connection, read `av_missions` and compare `project` with the AV configuration directory and `workspace` with the intended working repository. For the A/B case above, both `project=A` and `workspace=B` must match. This read-only check does not start work. If the current client cannot load the new integration until reload, report that step as pending. An `av_order` test would start a real mission and is outside setup verification.

Ask the client, for example: “Use AV to implement the checkout goal in this repository, verify it, and explain the result.” The skill carries your constraints into `av_order`. It can inspect existing missions, read status and reports, resume authorized work, and cancel a mission when asked.

| MCP tool | Purpose |
|---|---|
| `av_order` | Submit a goal; optional workspace, stable request ID, trusted verification command, parallelism and run/time/cost limits |
| `av_missions` | List saved missions in the bound repository |
| `av_status` | Inspect progress, actual state, and blockers by mission ID |
| `av_report` | Read the saved report and evidence |
| `av_resume` | Continue an existing mission; optional retry, request ID, and authorized budget/round overrides |
| `av_cancel` | Stop the specified mission |

`av_order` and `av_resume` accept work asynchronously: an accepted or `starting` response is still incomplete. Keep the returned mission ID and inspect its status. Generate and retain a `requestId` before the first submission; reuse that ID and identical input on retries. A new request ID represents a new submission. If a response is uncertain, inspect saved missions before creating another order. Reconnecting to MCP does not restart or cancel the independently supervised mission; inspect or resume the saved mission rather than submitting the goal again.

`waiting` includes pending observations or scheduled work; `paused` and `failed` require the recorded next action. The client should report success only after `completed` and the actual verification report, and identify the mission ID if its session ends while work remains. Report delivery needs the provider's confirmed receipt.

For an HTTP client that supports a configured static bearer token, start the loopback transport explicitly:

```bash
# Supply AGENT_VALLEY_MCP_TOKEN in the server environment: a random bearer token
# with at least 32 characters. Keep the value outside committed configuration.
av mcp --http --workspace /absolute/project --host localhost --port 3331 \
  --token-env AGENT_VALLEY_MCP_TOKEN --allowed-origin https://your-client.example
```

Pass every permitted browser origin using another `--allowed-origin` flag. AV binds only loopback and validates the upstream Host header. An HTTPS reverse proxy must forward `/mcp` with upstream `Host: localhost:3331` (or the selected loopback address/port) and a valid `Authorization: Bearer …` header. Preserve the client's Origin when present and allow that exact origin in AV.

For web chat clients, use AV's [OAuth gateway](./web-mcp.md) with a public HTTPS endpoint and an established identity provider. The gateway publishes resource metadata and verifies signed access tokens, audience, expiry, scopes, and permitted user subjects. The identity provider handles login, consent, PKCE, client registration, and refresh tokens. A local stdio entry alone cannot connect a web chat client. Project installation leaves clients on stdio and does not expose an HTTP server.

AV sets `AGENT_VALLEY_MANAGED_RUN=1` when it invokes a Chief Director or Actor. The client skill checks that variable before starting or resuming a mission and performs the assigned task directly in a managed run. Web clients without an environment tool inspect `av_missions.executionContext` and use the server's bound workspace. An Actor assignment or local managed flag takes priority over a remote server's context. The MCP server also enforces its managed-run guard.

The installer preserves other skills, settings, MCP entries, file permissions, and managed OMA definitions. It installs its own AV skill under Codex's supported `.agents/skills` directory from the product source and does not edit existing OMA skills. Repeating it updates an unchanged AV-owned skill and leaves matching MCP entries unchanged. It stops before changing any client when an existing `av` skill has no ownership receipt, was modified locally, or an `av` MCP entry belongs to another server/workspace. Keep a copy and move the conflicting item aside or reconcile that entry manually, then rerun the command. Invalid configuration and symlinks also produce actionable errors. This command does not edit user-level client profiles, enable trust, install client CLIs, or run a mission.

The skill carries existing authorization; it does not authorize publishing, merging, deployments, contacting people, purchases, or higher budgets. Those actions remain subject to your instructions and the client/AV execution policy.
