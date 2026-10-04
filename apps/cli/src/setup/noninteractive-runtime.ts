import { type SpawnOptions, spawn } from "node:child_process"
import { resolveGlobalConfigPath } from "@agent-valley/core/config/yaml-loader"
import { discoverAgents } from "../agent-discovery"
import { inspectChiefAgent, installChiefAgent, runTerminalCommand } from "../agent-provisioning"
import { parseClientToml, prepareClientIntegrations } from "../client-integrations"
import { applyIntegrationFiles } from "../client-integrations-files"
import { prepareOma } from "../oma-provisioning"
import type { NoninteractiveSetupDependencies } from "./noninteractive-types"
import type { AgentType } from "./types"

/** Reuse provisioning deadlines/cleanup while closing stdin and suppressing native installer output. */
const quietSpawn = (command: string, args: readonly string[], options: SpawnOptions) =>
  spawn(command, args, { ...options, stdio: "ignore" })

export function noninteractiveSetupDefaults(): NoninteractiveSetupDependencies {
  const env = { ...process.env, CI: "true" }
  // runTerminalCommand uses only spawn(command, argv, options), never the stream-specific overloads.
  const runCommand: typeof runTerminalCommand = (request) =>
    runTerminalCommand(request, quietSpawn as unknown as typeof spawn)
  return {
    projectRoot: process.cwd(),
    globalConfigPath: resolveGlobalConfigPath(),
    env: process.env,
    inspectActor: (actor) =>
      inspectChiefAgent(actor, { discover: () => discoverAgents({ env, parseToml: parseClientToml }) }),
    installActor: (actor) => installChiefAgent(actor, { env, runCommand }),
    prepareOma: (workspace) => prepareOma(workspace, { env, runCommand }),
    prepareIntegrations: (workspace, projectRoot) => prepareClientIntegrations(workspace, { projectRoot }),
    applyFiles: applyIntegrationFiles,
  }
}

export function currentRuntimeIdentity(
  env: Record<string, string | undefined>,
): { actorType: AgentType; source: string } | undefined {
  const identities: { actorType: AgentType; source: string }[] = []
  // Codex injects session identity into child commands; paths/API credentials are not runtime identity.
  const codex = ["CODEX_THREAD_ID", "CODEX_SESSION_ID"].find((key) => env[key]?.trim())
  if (codex) identities.push({ actorType: "codex", source: codex })
  const claude = ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION"].find((key) => env[key] === "1")
  if (claude) identities.push({ actorType: "claude", source: claude })
  if (identities.length > 1)
    throw new Error(
      "Current runtime identity is ambiguous. Rerun av setup --yes --actor <current-vendor> --model <current-model-or-empty>; do not use OMA defaults to identify the caller.",
    )
  return identities[0]
}
