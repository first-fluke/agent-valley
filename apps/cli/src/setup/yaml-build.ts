/**
 * Pure YAML builders.
 *
 * Kept stand-alone (no clack, no fs) so unit tests can exercise them
 * without touching the TUI. The Linear path preserves the original
 * `buildGlobalYaml` / `buildProjectYaml` signature for backwards
 * compatibility with the existing test file.
 */

import type { GlobalConfig, ProjectConfig } from "@agent-valley/core/config/yaml-loader"
import { stringify as yamlStringify } from "yaml"
import type { AgentType, TunnelSetupValues } from "./types"

export const DEFAULT_PROMPT = `You are working on {{issue.identifier}}: {{issue.title}}.

## Description
{{issue.description}}

## Workspace
Path: {{workspace_path}}

## Instructions
1. Read AGENTS.md first
2. Implement the requested changes
3. Run tests before finishing
`

export function buildGlobalYaml(config: { apiKey: string; agentType: string; maxParallel: number }): string {
  const obj: GlobalConfig = {
    linear: { api_key: config.apiKey },
    agent: { type: config.agentType as AgentType },
    logging: { level: "info", format: "json" },
    server: { port: 9741 },
  }
  return yamlStringify(obj, { lineWidth: 0 })
}

/**
 * Global config for a GitHub-only setup. No Linear key is written; the
 * agent type is still a global preference, not a tracker preference.
 */
export function buildGlobalYamlGithub(config: { agentType: string; maxParallel: number }): string {
  const obj: GlobalConfig = {
    agent: { type: config.agentType as AgentType },
    logging: { level: "info", format: "json" },
    server: { port: 9741 },
  }
  return yamlStringify(obj, { lineWidth: 0 })
}

/**
 * Translate the in-memory tunnel context into the shape persisted to
 * `valley.yaml`. Returns `undefined` when the context is absent OR when
 * the provider is the ngrok default with no extra fields — omitting the
 * block keeps the on-disk YAML minimal and preserves v0.2 compatibility.
 */
function buildTunnelBlock(tunnel: TunnelSetupValues | undefined): ProjectConfig["tunnel"] {
  if (!tunnel) return undefined
  if (tunnel.provider === "ngrok") return undefined
  if (tunnel.provider === "none") {
    return { provider: "none", cloudflare: { mode: "quick" } }
  }
  return {
    provider: "cloudflare",
    cloudflare: {
      mode: tunnel.cloudflare?.mode ?? "quick",
      name: tunnel.cloudflare?.name,
      hostname: tunnel.cloudflare?.hostname,
    },
  }
}

export function buildProjectYaml(config: {
  teamKey: string
  teamUuid: string
  webhookSecret: string
  todoStateId: string
  inProgressStateId: string
  doneStateId: string
  cancelledStateId: string
  workspaceRoot: string
  prompt?: string
  tunnel?: TunnelSetupValues
}): string {
  const obj: ProjectConfig = {
    tracker: { kind: "linear" },
    linear: {
      team_id: config.teamKey,
      team_uuid: config.teamUuid,
      webhook_secret: config.webhookSecret,
      workflow_states: {
        todo: config.todoStateId,
        in_progress: config.inProgressStateId,
        done: config.doneStateId,
        cancelled: config.cancelledStateId,
      },
    },
    workspace: { root: config.workspaceRoot },
    delivery: { mode: "merge" },
    prompt: config.prompt ?? DEFAULT_PROMPT,
  }
  const tunnel = buildTunnelBlock(config.tunnel)
  if (tunnel) obj.tunnel = tunnel
  return yamlStringify(obj, { lineWidth: 0 })
}

/**
 * Build the `valley.yaml` body for a GitHub tracker. Token is **never**
 * persisted; only the env var name is stored under `github.token_env`.
 */
export function buildProjectYamlGithub(config: {
  tokenEnv: string
  owner: string
  repo: string
  webhookSecret: string
  labels: { todo: string; inProgress: string; done: string; cancelled: string }
  workspaceRoot: string
  prompt?: string
  tunnel?: TunnelSetupValues
}): string {
  const obj: ProjectConfig = {
    tracker: { kind: "github" },
    github: {
      token_env: config.tokenEnv,
      owner: config.owner,
      repo: config.repo,
      webhook_secret: config.webhookSecret,
      labels: {
        todo: config.labels.todo,
        in_progress: config.labels.inProgress,
        done: config.labels.done,
        cancelled: config.labels.cancelled,
      },
    },
    workspace: { root: config.workspaceRoot },
    delivery: { mode: "merge" },
    prompt: config.prompt ?? DEFAULT_PROMPT,
  }
  const tunnel = buildTunnelBlock(config.tunnel)
  if (tunnel) obj.tunnel = tunnel
  return yamlStringify(obj, { lineWidth: 0 })
}
