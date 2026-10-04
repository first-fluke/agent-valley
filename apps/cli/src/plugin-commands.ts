import type { Command } from "commander"
import { exportPluginPackages } from "./plugin-export"

export function registerPluginCommands(program: Command): void {
  program
    .command("plugins")
    .description("Export native and portable AV plugin packages")
    .command("export")
    .requiredOption("--workspace <path>", "AV project/config directory to bind the MCP server")
    .requiredOption("--output <path>", "Destination for vendor packages and local marketplaces")
    .option("--remote-url <url>", "Authenticated HTTPS /mcp URL for remote or web clients")
    .action(async (options: { workspace: string; output: string; remoteUrl?: string }) => {
      const result = await exportPluginPackages(options)
      process.stdout.write(`Exported AV ${result.transport} plugins to ${result.output}\n`)
      for (const [vendor, path] of Object.entries(result.packages)) process.stdout.write(`  ${vendor}: ${path}\n`)
      process.stdout.write(`Install commands and client trust steps: ${result.output}/README.md\n`)
    })
}
