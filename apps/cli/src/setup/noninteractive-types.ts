import type { AgentAvailability, AgentReadiness } from "../agent-discovery"
import type { ProvisioningResult } from "../agent-provisioning"
import type { ClientIntegrationPlan, IntegrationClient } from "../client-integrations"
import type { IntegrationFile } from "../client-integrations-files"
import type { AgentType } from "./types"

export interface SetupOptions {
  yes?: boolean
  edit?: boolean
  mode?: string
  actor?: string
  model?: string
  workspace?: string
  verify?: string
  oma?: string
  json?: boolean
}

export interface NoninteractiveSetupResult {
  version: 1
  status: "ready" | "action_required" | "failed"
  exitCode: 0 | 2 | 1
  projectRoot: string
  workspace: string | null
  config: { project: string; global: string; saved: boolean }
  chief: {
    actorType: AgentType | null
    model: string | null
    actorSource: "explicit" | "runtime" | "project" | "global" | null
    modelSource:
      | "explicit"
      | "explicit-native-default"
      | "runtime-native-default"
      | "project"
      | "global"
      | "native-default"
    runtimeIdentity: string | null
    readiness: AgentReadiness | "not_checked"
    message: string
  }
  oma: { status: "prepared" | "skipped" | "failed" | "not_started"; message: string }
  integrations: { status: "installed" | "failed" | "not_started"; clients: IntegrationClient[]; files: string[] }
  nextActions: string[]
  error?: string
}

export interface NoninteractiveSetupDependencies {
  projectRoot: string
  globalConfigPath: string
  env: Record<string, string | undefined>
  inspectActor: (actor: AgentType) => Promise<AgentAvailability>
  installActor: (actor: AgentType) => Promise<ProvisioningResult>
  prepareOma: (workspace: string) => Promise<ProvisioningResult>
  prepareIntegrations: (workspace: string, projectRoot: string) => Promise<ClientIntegrationPlan>
  applyFiles: (root: string, files: IntegrationFile[]) => Promise<string[]>
}
