# Connect ChatGPT and Claude to AV

AV's HTTP OAuth gateway connects a web client to one configured AV project. The server runs on your machine or server, and the Chief Director executes missions there. Installing a plugin in a web account does not install or start AV on that machine.

Configure the project with `av setup` first. For web access, provide a public HTTPS endpoint and an OAuth/OIDC identity provider. AV verifies access tokens; the identity provider owns login, consent, authorization codes, PKCE, refresh tokens, and client registration.

## Configure the identity provider

Create a resource/API whose audience is your complete MCP URL, for example `https://av.example.com/mcp`. Configure the provider to honor the OAuth `resource` parameter and issue signed JWT access tokens with that audience. AV requires a subject, expiration, the configured issuer, and every required scope. Configure a scope such as `av:missions` and give it only to permitted users. Supply the permitted users' stable `sub` values to AV; email addresses are not substitutes unless your provider actually uses them as subjects.

The provider must publish OAuth authorization server or OIDC discovery metadata with HTTPS authorization, token, and JWKS endpoints and `S256` PKCE support. Use the authorization-code flow with a compatible predefined client, CIMD, or dynamic registration. Add the exact redirect URI shown by the ChatGPT or Claude connection UI to the provider's allowlist. ChatGPT's callback can depend on the provider's issuer identification support. See [OpenAI authentication requirements](https://developers.openai.com/plugins/build/auth) and [Claude remote connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

AV publishes protected resource metadata pointing to this external issuer. It validates the provider's discovery document at startup and verifies token signatures with its JWKS. It does not impersonate the provider's authorization server or accept opaque access tokens in this mode.

## Start the gateway

```bash
av mcp --http --workspace /absolute/av-project --host localhost --port 3331 \
  --public-url https://av.example.com/mcp \
  --oauth-issuer https://identity.example.com \
  --oauth-scope av:missions \
  --oauth-subject user_123
```

Repeat or list `--oauth-scope` and `--oauth-subject` values for additional scopes or users. `--oauth-audience` defaults to the public URL and must equal it. `--allowed-origin` permits exact browser origins when the client sends an Origin header. Authentication remains mandatory even for an allowed origin.

The same settings can come from the server environment:

| Variable | Value |
|---|---|
| `AGENT_VALLEY_MCP_PUBLIC_URL` | Canonical HTTPS URL ending in `/mcp` |
| `AGENT_VALLEY_MCP_OAUTH_ISSUER` | Exact external issuer URL |
| `AGENT_VALLEY_MCP_OAUTH_AUDIENCE` | Optional; must equal the public URL |
| `AGENT_VALLEY_MCP_OAUTH_SCOPES` | Space- or comma-separated required scopes |
| `AGENT_VALLEY_MCP_OAUTH_SUBJECTS` | Comma-separated permitted user subject IDs |

Explicit CLI values take priority over environment defaults. Supplying incomplete OAuth configuration fails with the missing setting and its fix. OAuth mode does not accept the static `AGENT_VALLEY_MCP_TOKEN` as a substitute for a user access token. Local stdio remains available without OAuth configuration.

AV binds loopback. Put your existing HTTPS reverse proxy in front of it and forward the MCP and resource discovery routes, preserving `Authorization` and any `Origin`. For example, a Caddy site can forward all routes:

```caddyfile
av.example.com {
  reverse_proxy localhost:3331
}
```

AV accepts the configured public Host or a loopback Host. Forwarded headers do not change the configured resource URL or issuer. Route discovery requests as well as `/mcp`; unauthenticated requests receive a `WWW-Authenticate` challenge containing the resource metadata URL. Tokens with an invalid signature, issuer, audience, expiry, scope, or unlisted subject cannot access mission tools or reports.

## Connect the account

In ChatGPT, enable Developer mode if your account and workspace permit it. Open the Plugins connection UI, create a connection with the HTTPS MCP URL, choose OAuth, and complete the provider's login and consent. Inspect the discovered tools before starting a mission. See [ChatGPT connection instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt).

In Claude, add the HTTPS URL through the custom remote connector UI and complete the provider's OAuth flow. A Claude Code plugin installation and a Claude web account connection are separate installations. See [Claude connector setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

Keep the server running while the client submits and inspects work. Missions already accepted by AV run independently of the MCP connection. Reconnect and inspect the saved mission ID after a connection loss.

For ChatGPT development, [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) can reach a private AV stdio server. Configure the tunnel's local MCP command as `av mcp --workspace /absolute/av-project`, keep its client running, and associate it with the intended ChatGPT workspace. Creating a tunnel and linking an account require your OpenAI organization/workspace permissions. A tunnel is a separate connection option; public plugin submission still requires a reachable HTTPS endpoint.

## Verify the connection

List the tools, inspect `av_missions`, and confirm the advertised project and workspace before ordering work. AV supplies eleven tools: `av_order`, `av_missions`, `av_status`, `av_report`, `av_resume`, `av_cancel`, `av_operations`, `av_operation_status`, `av_operation_report`, `av_operation_resume`, and `av_operation_cancel`. `av_order` starts continuous improvement by default; `once: true` runs one goal. Keep its returned operation or mission ID and inspect the corresponding status/report tools. The shared skill supports web clients without a local environment tool by checking the server's execution context.

The repository's tests exercise discovery, signed tokens, rejection paths, and MCP requests with a temporary identity provider. They do not establish that a particular deployed endpoint, real identity provider, or ChatGPT/Claude account is connected. Marketplace listing, account connection, and deployment require their respective external configuration and provider review.
