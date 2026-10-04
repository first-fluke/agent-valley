# Agent Valley plugin data handling

The public AV plugin contains manifests and instructions. It includes no hosted MCP endpoint, access token, or private repository path. Installations and account information handled by Claude, OpenAI, Cursor, Qwen, or Antigravity remain subject to those hosts' policies.

To execute work, configure an AV runtime and its agent providers. Your selected clients and model providers may receive goals, prompts, repository contents, tool results, and other context needed for the requested task. Their authentication, retention, and telemetry settings apply to that data.

AV saves mission state, process receipts, logs, verification evidence, and reports in the configured AV project's `.agent-valley` directory. Configuration lives in the project's `av.yaml` and the user's Agent Valley settings. The deployment operator controls those files, access permissions, backups, and retention. Removing a local file does not remove copies already sent to an external provider or included in a backup.

Configured reporting channels can receive reports and actual attachments. Browser capture can include the selected page's contents. Optional dashboard, relay, observability, and metric integrations exchange data with their configured services. Review those settings and recipients before enabling them.

With remote MCP, requests reach the configured AV server and its reverse proxy. OAuth login is handled by the configured identity provider. AV verifies access-token signatures, issuer, audience, expiry, scopes, and permitted user subjects before granting mission access. Server and identity-provider operators control their own logs and retention.

Do not include credentials or unnecessary personal information in a goal or report. Keep AV credentials outside public plugin packages and repository history. The project documents its configuration and operation in the [client guide](../docs/guides/agent-clients.md) and [web MCP guide](../docs/guides/web-mcp.md).

For project questions, use [GitHub issues](https://github.com/first-fluke/agent-valley/issues). Do not post credentials, private reports, or personal records in a public issue. Contact the operator of your AV deployment for questions about data stored or processed by that deployment.
