/**
 * Config Layer — Load and validate all configuration from .env + WORKFLOW.md.
 * Fails fast with actionable error messages.
 */

import { z } from "zod/v4"

const configSchema = z.object({
  linearApiKey: z.string().min(1, "LINEAR_API_KEY is not set.\n  Fix: Add LINEAR_API_KEY=lin_api_xxx to .env"),
  linearTeamId: z.string().min(1, "LINEAR_TEAM_ID is not set.\n  Fix: Add LINEAR_TEAM_ID=ACR to .env"),
  linearTeamUuid: z.string().min(1, "LINEAR_TEAM_UUID is not set.\n  Fix: Add LINEAR_TEAM_UUID=xxx to .env"),
  linearWebhookSecret: z.string().min(1, "LINEAR_WEBHOOK_SECRET is not set.\n  Fix: Add LINEAR_WEBHOOK_SECRET=whsec_xxx to .env"),
  workflowStates: z.object({
    todo: z.string().min(1, "LINEAR_WORKFLOW_STATE_TODO is not set.\n  Fix: Add LINEAR_WORKFLOW_STATE_TODO=<uuid> to .env"),
    inProgress: z.string().min(1, "LINEAR_WORKFLOW_STATE_IN_PROGRESS is not set.\n  Fix: Add LINEAR_WORKFLOW_STATE_IN_PROGRESS=<uuid> to .env"),
    done: z.string().min(1, "LINEAR_WORKFLOW_STATE_DONE is not set.\n  Fix: Add LINEAR_WORKFLOW_STATE_DONE=<uuid> to .env"),
    cancelled: z.string().min(1, "LINEAR_WORKFLOW_STATE_CANCELLED is not set.\n  Fix: Add LINEAR_WORKFLOW_STATE_CANCELLED=<uuid> to .env"),
  }),
  workspaceRoot: z.string().min(1, "WORKSPACE_ROOT is not set.").refine(
    (v) => v.startsWith("/"),
    "WORKSPACE_ROOT must be an absolute path.\n  Fix: Set WORKSPACE_ROOT=/absolute/path in .env"
  ),
  agentType: z.enum(["claude", "codex", "gemini"], {
    message: 'AGENT_TYPE must be "claude", "codex", or "gemini".\n  Fix: Set AGENT_TYPE=claude in .env'
  }),
  agentTimeout: z.number().min(30, "agent timeout must be >= 30 seconds"),
  agentMaxRetries: z.number().min(1),
  agentRetryDelay: z.number().min(1),
  maxParallel: z.number().min(1, "concurrency.max_parallel must be >= 1"),
  serverPort: z.number().min(1),
  logLevel: z.enum(["debug", "info", "warn", "error"]),
  logFormat: z.enum(["json", "text"]),
  integrations: z.object({
    github: z.object({
      token: z.string(),
      owner: z.string(),
      repo: z.string(),
      webhookSecret: z.string().optional(),
    }).optional(),
    slack: z.object({
      webhookUrl: z.string().url("SLACK_WEBHOOK_URL must be a valid URL.\n  Fix: Set SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx in .env"),
    }).optional(),
  }),
})

export type Config = z.infer<typeof configSchema>

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
    maxParallel: Number(env.MAX_PARALLEL ?? "3"),
    serverPort: Number(env.SERVER_PORT ?? "9741"),
    logLevel: (env.LOG_LEVEL ?? "info") as "debug" | "info" | "warn" | "error",
    logFormat: (env.LOG_FORMAT ?? "json") as "json" | "text",
    integrations: {
      github: env.GITHUB_TOKEN ? {
        token: env.GITHUB_TOKEN,
        owner: env.GITHUB_OWNER ?? "",
        repo: env.GITHUB_REPO ?? "",
        webhookSecret: env.GITHUB_WEBHOOK_SECRET,
      } : undefined,
      slack: env.SLACK_WEBHOOK_URL ? {
        webhookUrl: env.SLACK_WEBHOOK_URL,
      } : undefined,
    },
  }

  const result = configSchema.safeParse(raw)

  if (!result.success) {
    const issues = result.error.issues.map((e, i) => `  [${i + 1}] ${e.path.join(".")}: ${e.message}`).join("\n")
    console.error(`Config validation failed. Fix the following issues and restart:\n\n${issues}\n\nSymphony cannot start until all config errors are resolved.`)
    process.exit(1)
  }

  return result.data
}
