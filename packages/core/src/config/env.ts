/**
 * Config Layer — Load and validate all configuration from .env + WORKFLOW.md.
 * Fails fast with actionable error messages.
 */

import { z } from "zod"
import { detectHardware } from "./hardware"

const routingRuleSchema = z.object({
  label: z.string().min(1, "Each routing rule must have a non-empty label"),
  workspaceRoot: z
    .string()
    .min(1)
    .refine((v) => v.startsWith("/"), "workspaceRoot in routing rule must be an absolute path"),
  agentType: z.enum(["claude", "codex", "gemini"]).optional(),
  deliveryMode: z.enum(["merge", "pr"]).optional(),
})

export type RoutingRule = z.infer<typeof routingRuleSchema>

const scoreRoutingTierSchema = z
  .object({
    min: z.number().int().min(1).max(10),
    max: z.number().int().min(1).max(10),
    agent: z.enum(["claude", "codex", "gemini"]),
  })
  .refine(
    (v) => v.min <= v.max,
    "Each score tier must have min <= max.\n  Fix: Ensure min is less than or equal to max in SCORE_ROUTING",
  )

const scoreRoutingSchema = z
  .object({
    easy: scoreRoutingTierSchema,
    medium: scoreRoutingTierSchema,
    hard: scoreRoutingTierSchema,
  })
  .refine(
    (v) => v.easy.max < v.medium.min && v.medium.max < v.hard.min,
    "Score tiers must not overlap.\n  Fix: Ensure easy.max < medium.min and medium.max < hard.min in SCORE_ROUTING",
  )

export type ScoreRoutingConfig = z.infer<typeof scoreRoutingSchema>

const configSchema = z.object({
  linearApiKey: z.string().min(1, "LINEAR_API_KEY is not set.\n  Fix: Add LINEAR_API_KEY=lin_api_xxx to .env"),
  linearTeamId: z.string().min(1, "LINEAR_TEAM_ID is not set.\n  Fix: Add LINEAR_TEAM_ID=ACR to .env"),
  linearTeamUuid: z.string().min(1, "LINEAR_TEAM_UUID is not set.\n  Fix: Add LINEAR_TEAM_UUID=xxx to .env"),
  linearWebhookSecret: z
    .string()
    .min(1, "LINEAR_WEBHOOK_SECRET is not set.\n  Fix: Add LINEAR_WEBHOOK_SECRET=whsec_xxx to .env"),
  workflowStates: z.object({
    todo: z
      .string()
      .min(1, "LINEAR_WORKFLOW_STATE_TODO is not set.\n  Fix: Add LINEAR_WORKFLOW_STATE_TODO=<uuid> to .env"),
    inProgress: z
      .string()
      .min(
        1,
        "LINEAR_WORKFLOW_STATE_IN_PROGRESS is not set.\n  Fix: Add LINEAR_WORKFLOW_STATE_IN_PROGRESS=<uuid> to .env",
      ),
    done: z
      .string()
      .min(1, "LINEAR_WORKFLOW_STATE_DONE is not set.\n  Fix: Add LINEAR_WORKFLOW_STATE_DONE=<uuid> to .env"),
    cancelled: z
      .string()
      .min(1, "LINEAR_WORKFLOW_STATE_CANCELLED is not set.\n  Fix: Add LINEAR_WORKFLOW_STATE_CANCELLED=<uuid> to .env"),
  }),
  workspaceRoot: z
    .string()
    .min(1, "WORKSPACE_ROOT is not set.")
    .refine(
      (v) => v.startsWith("/"),
      "WORKSPACE_ROOT must be an absolute path.\n  Fix: Set WORKSPACE_ROOT=/absolute/path in .env",
    ),
  agentType: z.enum(["claude", "codex", "gemini"], {
    message: 'AGENT_TYPE must be "claude", "codex", or "gemini".\n  Fix: Set AGENT_TYPE=claude in .env',
  }),
  agentTimeout: z.number().min(30, "agent timeout must be >= 30 seconds"),
  agentMaxRetries: z.number().min(1),
  agentRetryDelay: z.number().min(1),
  maxParallel: z.number().min(1, "concurrency.max_parallel must be >= 1"),
  serverPort: z.number().min(1),
  logLevel: z.enum(["debug", "info", "warn", "error"]),
  logFormat: z.enum(["json", "text"]),
  deliveryMode: z.enum(["merge", "pr"]),
  routingRules: z.array(routingRuleSchema),
  scoringModel: z.string().optional(),
  scoreRouting: scoreRoutingSchema.optional(),
  // Team mode (optional — auto-detected)
  supabaseUrl: z.string().optional(),
  supabaseAnonKey: z.string().optional(),
  teamId: z.string().optional(),
  displayName: z.string().optional(),
})

export type Config = z.infer<typeof configSchema>

export function isTeamMode(config: Config): boolean {
  return !!(config.supabaseUrl && config.supabaseAnonKey && config.teamId)
}

export function parseScoreRouting(raw: string | undefined): z.infer<typeof scoreRoutingSchema> | undefined {
  if (!raw || raw.trim() === "") return undefined
  try {
    const parsed = JSON.parse(raw)
    const result = scoreRoutingSchema.safeParse(parsed)
    if (!result.success) {
      const issues = result.error.issues.map((e) => `  - ${e.path.join(".")}: ${e.message}`).join("\n")
      console.error(
        "SCORE_ROUTING validation failed:\n" +
          issues +
          "\n" +
          '  Fix: Set SCORE_ROUTING=\'{"easy":{"min":1,"max":3,"agent":"gemini"},"medium":{"min":4,"max":7,"agent":"codex"},"hard":{"min":8,"max":10,"agent":"claude"}}\' in .env\n' +
          "  Or remove SCORE_ROUTING to disable score-based routing.",
      )
      return process.exit(1)
    }
    return result.data
  } catch {
    console.error(
      "SCORE_ROUTING is not valid JSON.\n" +
        '  Fix: Set SCORE_ROUTING=\'{"easy":{"min":1,"max":3,"agent":"gemini"},...}\' in .env\n' +
        "  Or remove SCORE_ROUTING to disable score-based routing.",
    )
    return process.exit(1)
  }
}

export function parseRoutingRules(raw: string | undefined): RoutingRule[] {
  if (!raw || raw.trim() === "") return []
  try {
    return JSON.parse(raw) as RoutingRule[]
  } catch {
    console.error(
      "ROUTING_RULES is not valid JSON.\n" +
        '  Fix: Set ROUTING_RULES=\'[{"label":"backend","workspaceRoot":"/path/to/repo"}]\' in .env\n' +
        "  Or remove ROUTING_RULES to use the default WORKSPACE_ROOT for all issues.",
    )
    return process.exit(1)
  }
}

export function loadConfig(): Config {
  const env = process.env

  const raw = {
    linearApiKey: env.LINEAR_API_KEY ?? "",
    linearTeamId: env.LINEAR_TEAM_ID ?? "",
    linearTeamUuid: env.LINEAR_TEAM_UUID ?? "",
    linearWebhookSecret: env.LINEAR_WEBHOOK_SECRET ?? "",
    workflowStates: {
      todo: env.LINEAR_WORKFLOW_STATE_TODO ?? "",
      inProgress: env.LINEAR_WORKFLOW_STATE_IN_PROGRESS ?? "",
      done: env.LINEAR_WORKFLOW_STATE_DONE ?? "",
      cancelled: env.LINEAR_WORKFLOW_STATE_CANCELLED ?? "",
    },
    workspaceRoot: env.WORKSPACE_ROOT ?? "",
    agentType: env.AGENT_TYPE ?? "claude",
    agentTimeout: Number(env.AGENT_TIMEOUT ?? "3600"),
    agentMaxRetries: Number(env.AGENT_MAX_RETRIES ?? "3"),
    agentRetryDelay: Number(env.AGENT_RETRY_DELAY ?? "60"),
    maxParallel: Number(env.MAX_PARALLEL || detectHardware().recommended),
    serverPort: Number(env.SERVER_PORT ?? "9741"),
    logLevel: (env.LOG_LEVEL ?? "info") as "debug" | "info" | "warn" | "error",
    logFormat: (env.LOG_FORMAT ?? "json") as "json" | "text",
    deliveryMode: (env.DELIVERY_MODE ?? "merge") as "merge" | "pr",
    routingRules: parseRoutingRules(env.ROUTING_RULES),
    scoringModel: env.SCORING_MODEL || undefined,
    scoreRouting: parseScoreRouting(env.SCORE_ROUTING),
    supabaseUrl: env.SUPABASE_URL || undefined,
    supabaseAnonKey: env.SUPABASE_ANON_KEY || undefined,
    teamId: env.TEAM_ID || undefined,
    displayName: env.DISPLAY_NAME || undefined,
  }

  const result = configSchema.safeParse(raw)

  if (!result.success) {
    const issues = result.error.issues.map((e, i) => `  [${i + 1}] ${e.path.join(".")}: ${e.message}`).join("\n")
    console.error(
      `Config validation failed. Fix the following issues and restart:\n\n${issues}\n\nSymphony cannot start until all config errors are resolved.`,
    )
    process.exit(1)
  }

  return result.data
}
