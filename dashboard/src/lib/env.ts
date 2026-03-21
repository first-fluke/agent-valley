import { createEnv } from "@t3-oss/env-nextjs"
import { z } from "zod/v4"

export const env = createEnv({
  server: {
    LINEAR_API_KEY: z.string().min(1),
    LINEAR_TEAM_ID: z.string().min(1),
    LINEAR_TEAM_UUID: z.string().min(1),
    LINEAR_WEBHOOK_SECRET: z.string().min(1),
    LINEAR_WORKFLOW_STATE_TODO: z.string().min(1),
    LINEAR_WORKFLOW_STATE_IN_PROGRESS: z.string().min(1),
    LINEAR_WORKFLOW_STATE_DONE: z.string().min(1),
    LINEAR_WORKFLOW_STATE_CANCELLED: z.string().min(1),
    WORKSPACE_ROOT: z.string().startsWith("/"),
    AGENT_TYPE: z.enum(["claude", "codex", "gemini"]).default("claude"),
    AGENT_TIMEOUT: z.coerce.number().min(30).default(3600),
    AGENT_MAX_RETRIES: z.coerce.number().min(1).default(3),
    AGENT_RETRY_DELAY: z.coerce.number().min(1).default(60),
    MAX_PARALLEL: z.coerce.number().min(1).default(3),
    SERVER_PORT: z.coerce.number().min(1).default(9741),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    LOG_FORMAT: z.enum(["json", "text"]).default("json"),
  },
  runtimeEnv: {
    LINEAR_API_KEY: process.env.LINEAR_API_KEY,
    LINEAR_TEAM_ID: process.env.LINEAR_TEAM_ID,
    LINEAR_TEAM_UUID: process.env.LINEAR_TEAM_UUID,
    LINEAR_WEBHOOK_SECRET: process.env.LINEAR_WEBHOOK_SECRET,
    LINEAR_WORKFLOW_STATE_TODO: process.env.LINEAR_WORKFLOW_STATE_TODO,
    LINEAR_WORKFLOW_STATE_IN_PROGRESS: process.env.LINEAR_WORKFLOW_STATE_IN_PROGRESS,
    LINEAR_WORKFLOW_STATE_DONE: process.env.LINEAR_WORKFLOW_STATE_DONE,
    LINEAR_WORKFLOW_STATE_CANCELLED: process.env.LINEAR_WORKFLOW_STATE_CANCELLED,
    WORKSPACE_ROOT: process.env.WORKSPACE_ROOT,
    AGENT_TYPE: process.env.AGENT_TYPE,
    AGENT_TIMEOUT: process.env.AGENT_TIMEOUT,
    AGENT_MAX_RETRIES: process.env.AGENT_MAX_RETRIES,
    AGENT_RETRY_DELAY: process.env.AGENT_RETRY_DELAY,
    MAX_PARALLEL: process.env.MAX_PARALLEL,
    SERVER_PORT: process.env.SERVER_PORT,
    LOG_LEVEL: process.env.LOG_LEVEL,
    LOG_FORMAT: process.env.LOG_FORMAT,
  },
})

/** Convert t3-env to Orchestrator Config shape */
export function toOrchestratorConfig() {
  return {
    linearApiKey: env.LINEAR_API_KEY,
    linearTeamId: env.LINEAR_TEAM_ID,
    linearTeamUuid: env.LINEAR_TEAM_UUID,
    linearWebhookSecret: env.LINEAR_WEBHOOK_SECRET,
    workflowStates: {
      todo: env.LINEAR_WORKFLOW_STATE_TODO,
      inProgress: env.LINEAR_WORKFLOW_STATE_IN_PROGRESS,
      done: env.LINEAR_WORKFLOW_STATE_DONE,
      cancelled: env.LINEAR_WORKFLOW_STATE_CANCELLED,
    },
    workspaceRoot: env.WORKSPACE_ROOT,
    agentType: env.AGENT_TYPE,
    agentTimeout: env.AGENT_TIMEOUT,
    agentMaxRetries: env.AGENT_MAX_RETRIES,
    agentRetryDelay: env.AGENT_RETRY_DELAY,
    maxParallel: env.MAX_PARALLEL,
    serverPort: env.SERVER_PORT,
    logLevel: env.LOG_LEVEL,
    logFormat: env.LOG_FORMAT,
  }
}
