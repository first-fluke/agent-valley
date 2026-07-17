/**
 * doctor-config-checks.ts — Config, tunnel, and webhook-secret checks for
 * `av doctor`, plus the top-level orchestration that assembles every
 * check (agent CLI, sandbox from doctor-checks.ts + these) into one
 * report. Split out of doctor-checks.ts to stay under the
 * 500-line-per-file limit (docs/architecture/CONSTRAINTS.md).
 *
 * Config presence/validity is checked via `loadGlobalConfig` /
 * `loadProjectConfig` directly (never `loadConfig`, which calls
 * `process.exit(1)` on failure — unusable here since `av doctor` must
 * keep running and report every other check even when config is
 * broken).
 */

import { join } from "node:path"
import type { GlobalConfig, ProjectConfig } from "@agent-valley/core/config/yaml-loader"
import {
  AGENT_TYPES,
  type AgentType,
  type CheckResult,
  checkAgentAuthenticated,
  checkAgentInstalled,
  checkSandbox,
  type DoctorDeps,
} from "./doctor-checks"

// ── Tunnel ───────────────────────────────────────────────────────────────────

export function checkTunnel(project: ProjectConfig | null, deps: DoctorDeps): CheckResult {
  const provider = project?.tunnel?.provider ?? "ngrok"

  if (provider === "none") {
    return {
      id: "tunnel",
      name: "Tunnel (provider: none)",
      status: "pass",
      message: "Tunnel disabled by config (tunnel.provider: none) — webhooks must reach this host another way.",
      critical: false,
    }
  }

  if (provider === "cloudflare") {
    const resolved = deps.resolveBinary("cloudflared")
    if (!resolved) {
      return {
        id: "tunnel",
        name: "Tunnel (cloudflared)",
        status: "fail",
        message: "`cloudflared` not found on PATH",
        fix: "Install: brew install cloudflared (macOS), or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
        critical: false,
      }
    }
    const mode = project?.tunnel?.cloudflare?.mode ?? "quick"
    if (mode === "named") {
      const certPath = join(deps.home, ".cloudflared", "cert.pem")
      if (!deps.existsSync(certPath)) {
        return {
          id: "tunnel",
          name: "Tunnel (cloudflared, named mode)",
          status: "fail",
          message: `${certPath} not found — named tunnel requires cloudflared login`,
          fix: "Run `cloudflared tunnel login` to authenticate, then re-run `av doctor`.",
          critical: false,
        }
      }
    }
    return {
      id: "tunnel",
      name: "Tunnel (cloudflared)",
      status: "pass",
      message: `Found at ${resolved}`,
      critical: false,
    }
  }

  // ngrok
  const resolved = deps.resolveBinary("ngrok")
  if (!resolved) {
    return {
      id: "tunnel",
      name: "Tunnel (ngrok)",
      status: "fail",
      message: "`ngrok` not found on PATH",
      fix: "Install: brew install ngrok (https://ngrok.com/download), or set tunnel.provider: cloudflare in valley.yaml.",
      critical: false,
    }
  }
  if (deps.env.NGROK_AUTHTOKEN) {
    return {
      id: "tunnel",
      name: "Tunnel (ngrok)",
      status: "pass",
      message: `Found at ${resolved}; authtoken from NGROK_AUTHTOKEN env var`,
      critical: false,
    }
  }
  const ngrokConfigPath =
    deps.platform === "darwin"
      ? join(deps.home, "Library", "Application Support", "ngrok", "ngrok.yml")
      : join(deps.home, ".config", "ngrok", "ngrok.yml")
  if (!deps.existsSync(ngrokConfigPath)) {
    return {
      id: "tunnel",
      name: "Tunnel (ngrok authtoken)",
      status: "warn",
      message: `${ngrokConfigPath} not found — authtoken likely not configured`,
      fix: "Run `ngrok config add-authtoken <token>` (get a token at https://dashboard.ngrok.com/get-started/your-authtoken).",
      critical: false,
    }
  }
  try {
    const content = deps.readFileSync(ngrokConfigPath)
    if (!content.includes("authtoken")) {
      return {
        id: "tunnel",
        name: "Tunnel (ngrok authtoken)",
        status: "warn",
        message: `${ngrokConfigPath} present but no authtoken found`,
        fix: "Run `ngrok config add-authtoken <token>`.",
        critical: false,
      }
    }
  } catch {
    return {
      id: "tunnel",
      name: "Tunnel (ngrok authtoken)",
      status: "unknown",
      message: `${ngrokConfigPath} present but unreadable`,
      critical: false,
    }
  }
  return {
    id: "tunnel",
    name: "Tunnel (ngrok)",
    status: "pass",
    message: `Found at ${resolved}; authtoken configured`,
    critical: false,
  }
}

// ── Config ───────────────────────────────────────────────────────────────────

export interface ConfigCheckOutcome {
  results: CheckResult[]
  project: ProjectConfig | null
  global: GlobalConfig | null
}

export function checkConfig(deps: DoctorDeps): ConfigCheckOutcome {
  const results: CheckResult[] = []
  let global: GlobalConfig | null = null
  let project: ProjectConfig | null = null

  const globalPath = deps.resolveGlobalConfigPath()
  try {
    global = deps.loadGlobalConfig(globalPath)
    results.push(
      global
        ? {
            id: "config.global",
            name: "Global config (settings.yaml)",
            status: "pass",
            message: `Valid — ${globalPath}`,
            critical: false,
          }
        : {
            id: "config.global",
            name: "Global config (settings.yaml)",
            status: "warn",
            message: `${globalPath} not found`,
            fix: "Run `av setup` to create it (or `av setup --edit` to change individual values).",
            critical: false,
          },
    )
  } catch (err) {
    results.push({
      id: "config.global",
      name: "Global config (settings.yaml)",
      status: "fail",
      message: (err as Error).message,
      fix: `Fix the validation error above in ${globalPath}, or re-run \`av setup\` to regenerate it.`,
      critical: true,
    })
  }

  const projectPath = join(deps.cwd, "valley.yaml")
  try {
    project = deps.loadProjectConfig(deps.cwd)
    results.push(
      project
        ? {
            id: "config.project",
            name: "Project config (valley.yaml)",
            status: "pass",
            message: `Valid — ${projectPath}`,
            critical: false,
          }
        : {
            id: "config.project",
            name: "Project config (valley.yaml)",
            status: "fail",
            message: `${projectPath} not found`,
            fix: "Run `av setup` in this directory to create valley.yaml.",
            critical: true,
          },
    )
  } catch (err) {
    results.push({
      id: "config.project",
      name: "Project config (valley.yaml)",
      status: "fail",
      message: (err as Error).message,
      fix: `Fix the validation error above in ${projectPath}, or re-run \`av setup\` to regenerate it.`,
      critical: true,
    })
  }

  return { results, project, global }
}

export function resolveConfiguredAgentType(project: ProjectConfig | null, global: GlobalConfig | null): AgentType {
  return (project?.agent?.type ?? global?.agent?.type ?? "claude") as AgentType
}

export function resolveConfiguredTrackerKind(project: ProjectConfig | null): "linear" | "github" {
  if (project?.tracker?.kind) return project.tracker.kind
  if (!project?.linear && project?.github) return "github"
  return "linear"
}

export function checkWebhookSecret(project: ProjectConfig | null): CheckResult {
  const trackerKind = resolveConfiguredTrackerKind(project)
  if (trackerKind === "github") {
    const present = !!project?.github?.webhook_secret
    return present
      ? {
          id: "webhook.secret",
          name: "Webhook secret (github)",
          status: "pass",
          message: "github.webhook_secret is set",
          critical: false,
        }
      : {
          id: "webhook.secret",
          name: "Webhook secret (github)",
          status: "fail",
          message: "github.webhook_secret is not set",
          fix: "Add github.webhook_secret to valley.yaml (generate with `openssl rand -hex 32`, register the same value as the GitHub webhook secret).",
          critical: false,
        }
  }
  const present = !!project?.linear?.webhook_secret
  return present
    ? {
        id: "webhook.secret",
        name: "Webhook secret (linear)",
        status: "pass",
        message: "linear.webhook_secret is set",
        critical: false,
      }
    : {
        id: "webhook.secret",
        name: "Webhook secret (linear)",
        status: "fail",
        message: "linear.webhook_secret is not set",
        fix: "Add linear.webhook_secret to valley.yaml (copy the signing secret from the Linear webhook settings page).",
        critical: false,
      }
}

// ── Orchestration ────────────────────────────────────────────────────────────

export interface RunDoctorOptions {
  /** Check every supported agent CLI, not just the one resolved from config. */
  allAgents?: boolean
}

export async function runDoctorChecks(deps: DoctorDeps, options: RunDoctorOptions = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = []

  const { results: configResults, project, global } = checkConfig(deps)
  results.push(...configResults)

  const trackerKind = resolveConfiguredTrackerKind(project)
  const agentType = resolveConfiguredAgentType(project, global)
  results.push({
    id: "config.resolved",
    name: "Resolved config",
    status: "pass",
    message: `tracker: ${trackerKind}, agent: ${agentType}`,
    critical: false,
  })

  const agentsToCheck = options.allAgents ? AGENT_TYPES : [agentType]
  for (const agent of agentsToCheck) {
    results.push(checkAgentInstalled(agent, deps, agent === agentType))
    results.push(checkAgentAuthenticated(agent, deps))
  }

  results.push(await checkSandbox(deps))
  results.push(checkTunnel(project, deps))
  results.push(checkWebhookSecret(project))

  return results
}

export function computeExitCode(results: CheckResult[]): number {
  return results.some((r) => r.critical && r.status === "fail") ? 1 : 0
}

export function summarize(results: CheckResult[]): { passed: number; total: number } {
  return { passed: results.filter((r) => r.status === "pass").length, total: results.length }
}
