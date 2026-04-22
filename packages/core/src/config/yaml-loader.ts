/**
 * YAML Config Loader — Load and merge global + project configuration.
 *
 * Priority: valley.yaml (project) > settings.yaml (global) > hardcoded defaults.
 * Validates merged result with Zod. Fails fast with actionable error messages.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import { detectHardware } from "./hardware"

// ── Schemas ─────────────────────────────────────────────────────────

const routingRuleSchema = z.object({
  label: z.string().min(1, "Each routing rule must have a non-empty label"),
  workspace_root: z
    .string()
    .min(1)
    .refine((v) => v.startsWith("/"), "workspace_root in routing rule must be an absolute path"),
  agent_type: z.enum(["claude", "codex", "gemini"]).optional(),
  delivery_mode: z.enum(["merge", "pr"]).optional(),
})

const scoreRoutingTierSchema = z
  .object({
    min: z.number().int().min(1).max(10),
    max: z.number().int().min(1).max(10),
    agent: z.enum(["claude", "codex", "gemini"]),
  })
  .refine((v) => v.min <= v.max, "Each score tier must have min <= max")

const scoreRoutingSchema = z
  .object({
    easy: scoreRoutingTierSchema,
    medium: scoreRoutingTierSchema,
    hard: scoreRoutingTierSchema,
  })
  .refine(
    (v) => v.easy.max < v.medium.min && v.medium.max < v.hard.min,
    "Score tiers must not overlap. Ensure easy.max < medium.min and medium.max < hard.min",
  )

/** Schema for ~/.config/agent-valley/settings.yaml */
export const globalConfigSchema = z
  .object({
    linear: z
      .object({
        api_key: z.string().min(1).optional(),
      })
      .optional(),
    agent: z
      .object({
        type: z.enum(["claude", "codex", "gemini"]).optional(),
        timeout: z.number().min(30).optional(),
        max_retries: z.number().min(1).optional(),
        retry_delay: z.number().min(1).optional(),
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
        port: z.number().min(1).optional(),
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

export type GlobalConfig = z.infer<typeof globalConfigSchema>

/** Schema for <project>/valley.yaml */
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
    agent: z
      .object({
        type: z.enum(["claude", "codex", "gemini"]).optional(),
        timeout: z.number().min(30).optional(),
        max_retries: z.number().min(1).optional(),
        retry_delay: z.number().min(1).optional(),
      })
      .optional(),
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
        port: z.number().min(1).optional(),
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
  })
  .strict()

export type ProjectConfig = z.infer<typeof projectConfigSchema>

// ── Merged Config (validated output) ────────────────────────────────

const githubConfigSchema = z.object({
  token: z
    .string()
    .min(1, "github token resolved from token_env is empty.\n  Fix: export the env var named in github.token_env."),
  owner: z.string().min(1, "github.owner is not set.\n  Fix: Add github.owner to valley.yaml"),
  repo: z.string().min(1, "github.repo is not set.\n  Fix: Add github.repo to valley.yaml"),
  webhookSecret: z
    .string()
    .min(1, "github.webhook_secret is not set.\n  Fix: Add github.webhook_secret to valley.yaml"),
  labels: z.object({
    todo: z.string().min(1, "github.labels.todo is not set.\n  Fix: Add it to valley.yaml"),
    inProgress: z.string().min(1, "github.labels.in_progress is not set.\n  Fix: Add it to valley.yaml"),
    done: z.string().min(1, "github.labels.done is not set.\n  Fix: Add it to valley.yaml"),
    cancelled: z.string().min(1, "github.labels.cancelled is not set.\n  Fix: Add it to valley.yaml"),
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
      .min(1, "workspace.root is not set.\n  Fix: Add workspace.root to valley.yaml")
      .refine(
        (v) => v.startsWith("/"),
        "workspace.root must be an absolute path.\n  Fix: Set workspace.root: /absolute/path in valley.yaml",
      ),
    agentType: z.enum(["claude", "codex", "gemini"]),
    agentTimeout: z.number().min(30),
    agentMaxRetries: z.number().min(1),
    agentRetryDelay: z.number().min(1),
    maxParallel: z.number().min(1),
    serverPort: z.number().min(1),
    logLevel: z.enum(["debug", "info", "warn", "error"]),
    logFormat: z.enum(["json", "text"]),
    deliveryMode: z.enum(["merge", "pr"]),
    promptTemplate: z.string().min(1, "prompt is not set.\n  Fix: Add prompt field to valley.yaml"),
    routingRules: z.array(
      z.object({
        label: z.string().min(1),
        workspaceRoot: z
          .string()
          .min(1)
          .refine((v) => v.startsWith("/"), "workspaceRoot must be absolute"),
        agentType: z.enum(["claude", "codex", "gemini"]).optional(),
        deliveryMode: z.enum(["merge", "pr"]).optional(),
      }),
    ),
    scoringModel: z.string().optional(),
    scoreRouting: scoreRoutingSchema.optional(),
    supabaseUrl: z.string().optional(),
    supabaseAnonKey: z.string().optional(),
    teamId: z.string().optional(),
    displayName: z.string().optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.trackerKind === "linear") {
      const linearRequired: Array<[string, string, string]> = [
        [cfg.linearApiKey, "linearApiKey", "linear.api_key in ~/.config/agent-valley/settings.yaml or valley.yaml"],
        [cfg.linearTeamId, "linearTeamId", "linear.team_id in valley.yaml"],
        [cfg.linearTeamUuid, "linearTeamUuid", "linear.team_uuid in valley.yaml"],
        [cfg.linearWebhookSecret, "linearWebhookSecret", "linear.webhook_secret in valley.yaml"],
        [cfg.workflowStates.todo, "workflowStates.todo", "linear.workflow_states.todo in valley.yaml"],
        [
          cfg.workflowStates.inProgress,
          "workflowStates.inProgress",
          "linear.workflow_states.in_progress in valley.yaml",
        ],
        [cfg.workflowStates.done, "workflowStates.done", "linear.workflow_states.done in valley.yaml"],
        [cfg.workflowStates.cancelled, "workflowStates.cancelled", "linear.workflow_states.cancelled in valley.yaml"],
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

// ── File Loading ────────────────────────────────────────────────────

/** Resolve the global config directory, respecting XDG_CONFIG_HOME. */
export function resolveGlobalConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg ? join(xdg, "agent-valley") : join(homedir(), ".config", "agent-valley")
}

export function resolveGlobalConfigPath(): string {
  return join(resolveGlobalConfigDir(), "settings.yaml")
}

function readYamlFile(path: string): Record<string, unknown> | null {
  try {
    const content = readFileSync(path, "utf-8")
    if (!content.trim()) return null
    const parsed = parseYaml(content)
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw new Error(`Failed to parse ${path}: ${(err as Error).message}`)
  }
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
  const path = join(root, "valley.yaml")
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

function mergeConfigs(global: GlobalConfig | null, project: ProjectConfig | null): Record<string, unknown> {
  const hw = detectHardware()

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
  if (project?.github) {
    const envName = project.github.token_env ?? "GITHUB_TOKEN"
    const token = process.env[envName] ?? ""
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
    agentType: project?.agent?.type ?? global?.agent?.type ?? defaults.agentType,
    agentTimeout: project?.agent?.timeout ?? global?.agent?.timeout ?? defaults.agentTimeout,
    agentMaxRetries: project?.agent?.max_retries ?? global?.agent?.max_retries ?? defaults.agentMaxRetries,
    agentRetryDelay: project?.agent?.retry_delay ?? global?.agent?.retry_delay ?? defaults.agentRetryDelay,
    maxParallel: defaults.maxParallel,
    serverPort: project?.server?.port ?? global?.server?.port ?? defaults.serverPort,
    logLevel: project?.logging?.level ?? global?.logging?.level ?? defaults.logLevel,
    logFormat: project?.logging?.format ?? global?.logging?.format ?? defaults.logFormat,
    deliveryMode: project?.delivery?.mode ?? defaults.deliveryMode,
    promptTemplate: project?.prompt ?? "",
    routingRules: (project?.routing?.rules ?? []).map((r) => ({
      label: r.label,
      workspaceRoot: r.workspace_root,
      agentType: r.agent_type,
      deliveryMode: r.delivery_mode,
    })),
    scoringModel: project?.scoring?.model ?? undefined,
    scoreRouting: project?.scoring?.routes ?? undefined,
    supabaseUrl: project?.team?.supabase_url ?? global?.team?.supabase_url ?? undefined,
    supabaseAnonKey: project?.team?.supabase_anon_key ?? global?.team?.supabase_anon_key ?? undefined,
    teamId: project?.team?.id ?? global?.team?.id ?? undefined,
    displayName: project?.team?.display_name ?? global?.team?.display_name ?? undefined,
  }
}

// ── Public API ──────────────────────────────────────────────────────

export function isTeamMode(config: Config): boolean {
  return !!(config.supabaseUrl && config.supabaseAnonKey && config.teamId)
}

/**
 * Load configuration from settings.yaml (global) + valley.yaml (project).
 * Merges with project winning, validates with Zod, returns typed Config.
 */
export function loadConfig(projectRoot?: string, globalConfigPath?: string): Config {
  const global = loadGlobalConfig(globalConfigPath)
  const project = loadProjectConfig(projectRoot)

  if (!project) {
    const root = projectRoot ?? process.cwd()
    const valleyPath = join(root, "valley.yaml")
    console.error(
      `valley.yaml not found at ${valleyPath}.\n` +
        "  Fix: Run 'av setup' in your project directory to create valley.yaml.\n" +
        "  Or create valley.yaml manually — see docs/plans/config-layer-split-design.md for format.",
    )
    process.exit(1)
  }

  const merged = mergeConfigs(global, project)
  const result = mergedConfigSchema.safeParse(merged)

  if (!result.success) {
    const issues = result.error.issues.map((e, i) => `  [${i + 1}] ${e.path.join(".")}: ${e.message}`).join("\n")
    console.error(
      `Config validation failed. Fix the following issues and restart:\n\n${issues}\n\n` +
        "Symphony cannot start until all config errors are resolved.",
    )
    process.exit(1)
  }

  return result.data
}
