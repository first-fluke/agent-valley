import { resolve } from "node:path"
import type { Command } from "commander"
import { installClientIntegrationsCommand } from "./client-integrations"
import { resolveMcpOAuthOptions } from "./mcp-oauth"
import { startAvMcpStdio } from "./mcp-server"
import { startAvMcpHttp } from "./mcp-server-http"
import { MissionApi } from "./mission-api"
import { registerPluginCommands } from "./plugin-commands"

export function registerAgentClientCommands(program: Command): void {
  registerPluginCommands(program)
  program
    .command("integrations")
    .description("Install AV skills and MCP settings for AI clients")
    .command("install")
    .option("--workspace <path>", "Project repository (default: current directory)")
    .option("--project-root <path>", "AV project/config directory when it differs from the installation target")
    .action(installClientIntegrationsCommand)

  program
    .command("mcp")
    .description("Expose mission tools to MCP clients")
    .option(
      "--workspace <path>",
      "AV project/config directory; workspace.root selects the target Git repository",
      process.cwd(),
    )
    .option("--http", "Serve authenticated Streamable HTTP instead of stdio")
    .option("--host <host>", "HTTP loopback host", "localhost")
    .option("--port <port>", "HTTP port", "3331")
    .option("--token-env <name>", "HTTP bearer token environment variable", "AGENT_VALLEY_MCP_TOKEN")
    .option("--allowed-origin <origin...>", "Allowed HTTP browser/proxy origins")
    .option("--public-url <url>", "Canonical HTTPS /mcp URL for OAuth clients")
    .option("--oauth-issuer <url>", "External OAuth/OIDC authorization server issuer")
    .option("--oauth-audience <url>", "Token audience (defaults to the public MCP URL)")
    .option("--oauth-scope <scope...>", "Required OAuth scopes")
    .option("--oauth-subject <subject...>", "Allowed OAuth user subject IDs")
    .action(
      async (options: {
        workspace: string
        http?: boolean
        host: string
        port: string
        tokenEnv: string
        allowedOrigin?: string[]
        publicUrl?: string
        oauthIssuer?: string
        oauthAudience?: string
        oauthScope?: string[]
        oauthSubject?: string[]
      }) => {
        if (
          !options.http &&
          [
            options.publicUrl,
            options.oauthIssuer,
            options.oauthAudience,
            options.oauthScope,
            options.oauthSubject,
          ].some((value) => value !== undefined)
        )
          throw new Error("OAuth gateway options require av mcp --http. Omit them to use local stdio.")
        const oauth = options.http ? resolveMcpOAuthOptions(options) : undefined
        const project = resolve(options.workspace)
        const api = await MissionApi.create(project)
        const workspace = api.targetWorkspace
        try {
          if (options.http) {
            const port = Number(options.port)
            if (!/^\d+$/.test(options.port) || !Number.isInteger(port) || port < 1 || port > 65_535)
              throw new Error("Set --port to an integer between 1 and 65535.")
            const server = await startAvMcpHttp(api, {
              workspace,
              host: options.host,
              port,
              tokenEnv: options.tokenEnv,
              allowedOrigins: options.allowedOrigin,
              oauth,
            })
            process.stderr.write(`AV MCP listening at ${server.url}\n`)
          } else await startAvMcpStdio(api, { workspace })
        } catch (error) {
          await api.close()
          throw error
        }
      },
    )
}
