import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { actorDefaultsSchema, normalizeActorDefaults, routingRuleSchema, scoreRoutingSchema } from "./actor-schema"
import { budgetMergedSchema, budgetProjectSchema, buildBudgetConfig } from "./budget-schema"
import { chiefConfigSchema, mergeChiefConfig } from "./chief-schema"
import { detectHardware } from "./hardware"
import { resolveMaxParallel } from "./merge-helpers"
import { buildObservabilityConfig, observabilityMergedSchema, observabilityProjectSchema } from "./observability-schema"
import { resolveProjectConfigPath } from "./project-config-path"
import { resolvedTaskSchema, taskSchema } from "./task-schema"
import { buildTunnelConfig, tunnelMergedSchema, tunnelProjectSchema } from "./tunnel-schema"
import { buildVerifyConfig, verifyMergedSchema, verifyProjectSchema } from "./verify-schema"
import { readYamlFile } from "./yaml-file"

/** Schema for ~/.config/agent-valley/settings.yaml */
export const globalConfigSchema = z
  .object({
    linear: z
      .object({
        api_key: z.string().min(1).optional(),
      })
      .optional(),
    actor: actorDefaultsSchema.optional(),
    agent: actorDefaultsSchema.optional(),
    chief: chiefConfigSchema.optional(),
    logging: z
      .object({
        level: z.enum(["debug", "info", "warn", "error"]).optional(),
        format: z.enum(["json", "text"]).optional(),
      })
      .optional(),
    server: z
      .object({
        port: z.number().int().min(1).max(65535).optional(),
      })
      .optional(),
    team: z
      .object({
        supabase_url: z.string().optional(),
        supabase_anon_key: z.string().optional(),
        id: z.string().optional(),
        display_name: z.string().optional(),
      })
      .optional(),
  })
  .strict()
  .overwrite(normalizeActorDefaults)

export type GlobalConfig = z.infer<typeof globalConfigSchema>

/** Schema for <project>/av.yaml */
export const projectConfigSchema = z
  .object({
    tracker: z
      .object({
        kind: z.enum(["linear", "github"]).optional(),
      })
      .optional(),
    linear: z
      .object({
        api_key: z.string().min(1).optional(),
        team_id: z.string().min(1).optional(),
        team_uuid: z.string().min(1).optional(),
        webhook_secret: z.string().min(1).optional(),
        workflow_states: z
          .object({
            todo: z.string().min(1).optional(),
            in_progress: z.string().min(1).optional(),
            done: z.string().min(1).optional(),
            cancelled: z.string().min(1).optional(),
          })
          .optional(),
      })
      .optional(),
    github: z
      .object({
        /** Name of the env var that holds the token (e.g. "GITHUB_TOKEN"). */
        token_env: z.string().min(1).optional(),
        owner: z.string().min(1).optional(),
        repo: z.string().min(1).optional(),
        webhook_secret: z.string().min(1).optional(),
        labels: z
          .object({
            todo: z.string().min(1).optional(),
            in_progress: z.string().min(1).optional(),
            done: z.string().min(1).optional(),
            cancelled: z.string().min(1).optional(),
          })
          .optional(),
      })
      .optional(),
    workspace: z
      .object({
        root: z.string().min(1).optional(),
      })
      .optional(),
    actor: actorDefaultsSchema.optional(),
    agent: actorDefaultsSchema.optional(),
    delivery: z
      .object({
        mode: z.enum(["merge", "pr"]).optional(),
      })
      .optional(),
    logging: z
      .object({
        level: z.enum(["debug", "info", "warn", "error"]).optional(),
        format: z.enum(["json", "text"]).optional(),
      })
      .optional(),
    server: z
      .object({
        port: z.number().int().min(1).max(65535).optional(),
      })
      .optional(),
    prompt: z.string().optional(),
    routing: z
      .object({
        rules: z.array(routingRuleSchema).optional(),
      })
      .optional(),
    scoring: z
      .object({
        model: z.string().optional(),
        routes: scoreRoutingSchema.optional(),
      })
      .optional(),
    team: z
      .object({
        supabase_url: z.string().optional(),
        supabase_anon_key: z.string().optional(),
        id: z.string().optional(),
        display_name: z.string().optional(),
      })
      .optional(),
    observability: observabilityProjectSchema,
    budget: budgetProjectSchema,
    tunnel: tunnelProjectSchema,
    verify: verifyProjectSchema,
    task: taskSchema.optional(),
    oma: z.object({ mode: z.enum(["off", "strict"]).default("off") }).optional(),
    chief: chiefConfigSchema.optional(),
  })
  .strict()
  .overwrite(normalizeActorDefaults)

export type ProjectConfig = z.infer<typeof projectConfigSchema>
const githubConfigSchema = z.object({
  token: z
    .string()
    .min(1, "github token resolved from token_env is empty.\n  Fix: export the env var named in github.token_env."),
  owner: z.string().min(1, "github.owner is not set.\n  Fix: Add github.owner to av.yaml"),
  repo: z.string().min(1, "github.repo is not set.\n  Fix: Add github.repo to av.yaml"),
  webhookSecret: z.string().min(1, "github.webhook_secret is not set.\n  Fix: Add github.webhook_secret to av.yaml"),
  labels: z.object({
    todo: z.string().min(1, "github.labels.todo is not set.\n  Fix: Add it to av.yaml"),
    inProgress: z.string().min(1, "github.labels.in_progress is not set.\n  Fix: Add it to av.yaml"),
    done: z.string().min(1, "github.labels.done is not set.\n  Fix: Add it to av.yaml"),
    cancelled: z.string().min(1, "github.labels.cancelled is not set.\n  Fix: Add it to av.yaml"),
  }),
})

export type GithubTrackerConfig = z.infer<typeof githubConfigSchema>

const mergedConfigSchema = z
  .object({
    trackerKind: z.enum(["linear", "github"]),
    linearApiKey: z.string(),
    linearTeamId: z.string(),
    linearTeamUuid: z.string(),
    linearWebhookSecret: z.string(),
    workflowStates: z.object({
      todo: z.string(),
      inProgress: z.string(),
      done: z.string(),
      cancelled: z.string(),
    }),
    github: githubConfigSchema.optional(),
    workspaceRoot: z
      .string()
      .min(1, "workspace.root is not set.\n  Fix: Add workspace.root to av.yaml")
      .refine(
        (v) => v.startsWith("/"),
        "workspace.root must be an absolute path.\n  Fix: Set workspace.root: /absolute/path in av.yaml",
      ),
    agentType: z.enum(["claude", "codex", "antigravity", "cursor", "grok", "kimi", "opencode"]),
    agentTimeout: z.number().min(30),
    agentMaxRetries: z.number().min(1),
    agentRetryDelay: z.number().min(1),
    maxParallel: z.number().min(1),
    serverPort: z.number().int().min(1).max(65535),
    logLevel: z.enum(["debug", "info", "warn", "error"]),
    logFormat: z.enum(["json", "text"]),
    deliveryMode: z.enum(["merge", "pr"]),
    promptTemplate: z.string().min(1, "prompt is not set.\n  Fix: Add prompt field to av.yaml"),
    routingRules: z.array(
      z.object({
        label: z.string().min(1),
        workspaceRoot: z
          .string()
          .min(1)
          .refine((v) => v.startsWith("/"), "workspaceRoot must be absolute"),
        agentType: z.enum(["claude", "codex", "antigravity", "cursor", "grok", "kimi", "opencode"]).optional(),
        deliveryMode: z.enum(["merge", "pr"]).optional(),
        verifyCommand: z.string().optional(),
        task: resolvedTaskSchema.optional(),
      }),
    ),
    scoringModel: z.string().optional(),
    scoreRouting: scoreRoutingSchema.optional(),
    supabaseUrl: z.string().optional(),
    supabaseAnonKey: z.string().optional(),
    teamId: z.string().optional(),
    displayName: z.string().optional(),
    observability: observabilityMergedSchema,
    budget: budgetMergedSchema,
    tunnel: tunnelMergedSchema,
    verify: verifyMergedSchema,
    task: resolvedTaskSchema.optional(),
    oma: z.object({ mode: z.enum(["off", "strict"]) }).optional(),
    chief: chiefConfigSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.trackerKind === "linear") {
      const linearRequired: Array<[string, string, string]> = [
        [cfg.linearApiKey, "linearApiKey", "linear.api_key in ~/.config/agent-valley/settings.yaml or av.yaml"],
        [cfg.linearTeamId, "linearTeamId", "linear.team_id in av.yaml"],
        [cfg.linearTeamUuid, "linearTeamUuid", "linear.team_uuid in av.yaml"],
        [cfg.linearWebhookSecret, "linearWebhookSecret", "linear.webhook_secret in av.yaml"],
        [cfg.workflowStates.todo, "workflowStates.todo", "linear.workflow_states.todo in av.yaml"],
        [cfg.workflowStates.inProgress, "workflowStates.inProgress", "linear.workflow_states.in_progress in av.yaml"],
        [cfg.workflowStates.done, "workflowStates.done", "linear.workflow_states.done in av.yaml"],
        [cfg.workflowStates.cancelled, "workflowStates.cancelled", "linear.workflow_states.cancelled in av.yaml"],
      ]
      for (const [value, path, fix] of linearRequired) {
        if (!value) {
          ctx.addIssue({
            code: "custom",
            path: path.split("."),
            message: `${path} is not set.\n  Fix: Add ${fix}.`,
          })
        }
      }
    }
    if (cfg.trackerKind === "github") {
      if (!cfg.github) {
        ctx.addIssue({
          code: "custom",
          path: ["github"],
          message:
            "github config is required when tracker.kind === 'github'.\n" +
            "  Fix: Add a github: section with token_env, owner, repo, webhook_secret, and labels.",
        })
      }
    }
  })

export type Config = z.infer<typeof mergedConfigSchema>

// Re-export for backward compatibility
export type RoutingRule = z.infer<typeof routingRuleSchema>
export type ScoreRoutingConfig = z.infer<typeof scoreRoutingSchema>
export type { TunnelConfig } from "./tunnel-schema"

// ── File Loading ────────────────────────────────────────────────────

/** Resolve the global config directory, respecting XDG_CONFIG_HOME. */
export function resolveGlobalConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg ? join(xdg, "agent-valley") : join(homedir(), ".config", "agent-valley")
}

export function resolveGlobalConfigPath(): string {
  return join(resolveGlobalConfigDir(), "settings.yaml")
}

export function loadGlobalConfig(configPath?: string): GlobalConfig | null {
  const path = configPath ?? resolveGlobalConfigPath()
  const raw = readYamlFile(path)
  if (!raw) return null

  const result = globalConfigSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((e) => `  - ${e.path.join(".")}: ${e.message}`).join("\n")
    throw new Error(`Global config validation failed (${path}):\n${issues}`)
  }
  return result.data
}

export function loadProjectConfig(projectRoot?: string): ProjectConfig | null {
  const root = projectRoot ?? process.cwd()
  const path = resolveProjectConfigPath(root)
  const raw = readYamlFile(path)
  if (!raw) return null

  const result = projectConfigSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((e) => `  - ${e.path.join(".")}: ${e.message}`).join("\n")
    throw new Error(`Project config validation failed (${path}):\n${issues}`)
  }
  return result.data
}

// ── Merge ───────────────────────────────────────────────────────────

/**
 * Resolve actor.max_parallel with precedence project > global > hardware
 * default. An explicit operator value that exceeds the hardware-recommended
 * concurrency is honored (never silently clamped) but logged as a WARN so
 * the operator can see the risk of resource exhaustion.
 */
function mergeConfigs(
  global: GlobalConfig | null,
  project: ProjectConfig | null,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> {
  const hw = detectHardware()
  const projectActor = project?.actor ?? project?.agent
  const globalActor = global?.actor ?? global?.agent

  // Defaults
  const defaults = {
    agentType: "claude" as const,
    agentTimeout: 3600,
    agentMaxRetries: 3,
    agentRetryDelay: 60,
    maxParallel: hw.recommended,
    serverPort: 9741,
    logLevel: "info" as const,
    logFormat: "json" as const,
    deliveryMode: "merge" as const,
  }

  // Tracker kind: explicit > inferred. Linear block present -> linear; else
  // github block present -> github; fall back to linear for backwards compat.
  let trackerKind: "linear" | "github" = project?.tracker?.kind ?? "linear"
  if (!project?.tracker?.kind) {
    if (!project?.linear && project?.github) trackerKind = "github"
  }

  // GitHub: resolve token from named env var. Empty string fails validation
  // later via the trackerKind=github refinement.
  let githubMerged: Record<string, unknown> | undefined
  if (trackerKind === "github" && project?.github) {
    const envName = project.github.token_env ?? "GITHUB_TOKEN"
    const token = env[envName] ?? ""
    githubMerged = {
      token,
      owner: project.github.owner ?? "",
      repo: project.github.repo ?? "",
      webhookSecret: project.github.webhook_secret ?? "",
      labels: {
        todo: project.github.labels?.todo ?? "",
        inProgress: project.github.labels?.in_progress ?? "",
        done: project.github.labels?.done ?? "",
        cancelled: project.github.labels?.cancelled ?? "",
      },
    }
  }

  // Build merged config: project > global > defaults
  return {
    trackerKind,
    linearApiKey: project?.linear?.api_key ?? global?.linear?.api_key ?? "",
    linearTeamId: project?.linear?.team_id ?? "",
    linearTeamUuid: project?.linear?.team_uuid ?? "",
    linearWebhookSecret: project?.linear?.webhook_secret ?? "",
    workflowStates: {
      todo: project?.linear?.workflow_states?.todo ?? "",
      inProgress: project?.linear?.workflow_states?.in_progress ?? "",
      done: project?.linear?.workflow_states?.done ?? "",
      cancelled: project?.linear?.workflow_states?.cancelled ?? "",
    },
    github: githubMerged,
    workspaceRoot: project?.workspace?.root ?? "",
    agentType: projectActor?.type ?? globalActor?.type ?? defaults.agentType,
    agentTimeout: projectActor?.timeout ?? globalActor?.timeout ?? defaults.agentTimeout,
    agentMaxRetries: projectActor?.max_retries ?? globalActor?.max_retries ?? defaults.agentMaxRetries,
    agentRetryDelay: projectActor?.retry_delay ?? globalActor?.retry_delay ?? defaults.agentRetryDelay,
    maxParallel: resolveMaxParallel(projectActor?.max_parallel ?? globalActor?.max_parallel, hw.recommended),
    serverPort: project?.server?.port ?? global?.server?.port ?? defaults.serverPort,
    logLevel: project?.logging?.level ?? global?.logging?.level ?? defaults.logLevel,
    logFormat: project?.logging?.format ?? global?.logging?.format ?? defaults.logFormat,
    deliveryMode: project?.delivery?.mode ?? defaults.deliveryMode,
    promptTemplate: project?.prompt ?? "",
    routingRules: (project?.routing?.rules ?? []).map((r) => ({
      label: r.label,
      workspaceRoot: r.workspace_root,
      agentType: r.actor_type ?? r.agent_type,
      deliveryMode: r.delivery_mode,
      verifyCommand: r.verify_command,
      task: r.task?.kind === "analysis" ? { kind: "analysis" as const, reportPath: r.task.report_path } : r.task,
    })),
    scoringModel: project?.scoring?.model ?? undefined,
    scoreRouting: project?.scoring?.routes ?? undefined,
    supabaseUrl: project?.team?.supabase_url ?? global?.team?.supabase_url ?? undefined,
    supabaseAnonKey: project?.team?.supabase_anon_key ?? global?.team?.supabase_anon_key ?? undefined,
    teamId: project?.team?.id ?? global?.team?.id ?? undefined,
    displayName: project?.team?.display_name ?? global?.team?.display_name ?? undefined,
    observability: buildObservabilityConfig(project),
    budget: buildBudgetConfig(project),
    tunnel: buildTunnelConfig(project),
    verify: buildVerifyConfig(project),
    task:
      project?.task?.kind === "analysis"
        ? { kind: "analysis" as const, reportPath: project.task.report_path }
        : { kind: "code" as const },
    oma: { mode: project?.oma?.mode ?? "off" },
    chief: global?.chief || project?.chief ? mergeChiefConfig(global?.chief, project?.chief) : undefined,
  }
}
// ── Public API ──────────────────────────────────────────────────────

export function isTeamMode(config: Config): boolean {
  return !!(config.supabaseUrl && config.supabaseAnonKey && config.teamId)
}

/** Validate the effective configuration without terminating the caller. */
export function resolveConfig(
  global: GlobalConfig | null,
  project: ProjectConfig,
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const result = mergedConfigSchema.safeParse(mergeConfigs(global, project, env))
  if (!result.success) {
    const issues = result.error.issues.map((e, i) => `  [${i + 1}] ${e.path.join(".")}: ${e.message}`).join("\n")
    throw new Error(`Config validation failed. Fix the following issues and restart:\n\n${issues}`)
  }
  return result.data
}

/** Load global and project YAML, apply project overrides, and validate the merged configuration. */
export function loadConfig(projectRoot?: string, globalConfigPath?: string): Config {
  const global = loadGlobalConfig(globalConfigPath)
  const project = loadProjectConfig(projectRoot)

  if (!project) {
    const root = projectRoot ?? process.cwd()
    const projectPath = join(root, "av.yaml")
    console.error(
      `av.yaml not found at ${projectPath}.\n` +
        "  Fix: Run 'av setup' in your project directory to create av.yaml.\n" +
        "  Or create av.yaml manually — see docs/plans/config-layer-split-design.md for format.",
    )
    process.exit(1)
  }

  try {
    return resolveConfig(global, project)
  } catch (error) {
    console.error(`${(error as Error).message}\n\nSymphony cannot start until all config errors are resolved.`)
    process.exit(1)
  }
}
