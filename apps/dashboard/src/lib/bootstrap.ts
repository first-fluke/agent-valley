/**
 * Orchestrator bootstrap — Node.js only.
 * Separated from instrumentation.ts to avoid Edge Runtime static analysis warnings.
 */

import { toOrchestratorConfig } from "@/lib/env"
import { configureLogger, logger } from "@agent-valley/core/observability/logger"
import { Orchestrator } from "@agent-valley/core/orchestrator/orchestrator"
import { LinearTrackerAdapter } from "@agent-valley/core/tracker/adapters/linear-adapter"
import { LinearWebhookReceiver } from "@agent-valley/core/tracker/adapters/linear-webhook-receiver"
import { FileSystemWorkspaceGateway } from "@agent-valley/core/workspace/adapters/fs-workspace-gateway"
import { WorkspaceManager } from "@agent-valley/core/workspace/workspace-manager"
import { setOrchestrator } from "@/lib/orchestrator-singleton"
import { resolveProjectRoot } from "@/lib/project-root"

export async function bootstrap() {
  // Resolve project root: walk up until we find valley.yaml
  const projectRoot = await resolveProjectRoot(process.cwd())
  process.chdir(projectRoot)

  // Prevent orchestrator errors from crashing the Next.js process
  process.on("uncaughtException", (err) => {
    logger.error("process", `Uncaught exception (non-fatal): ${err.message}`, { stack: err.stack })
  })
  process.on("unhandledRejection", (reason) => {
    logger.error("process", `Unhandled rejection (non-fatal): ${reason}`)
  })

  const config = toOrchestratorConfig(projectRoot)
  configureLogger(config.logLevel, config.logFormat)

  const tracker = new LinearTrackerAdapter({
    apiKey: config.linearApiKey,
    teamId: config.linearTeamId,
    teamUuid: config.linearTeamUuid,
  })
  const webhook = new LinearWebhookReceiver({
    secret: config.linearWebhookSecret,
    workflowStates: config.workflowStates,
  })
  const workspace = new FileSystemWorkspaceGateway(new WorkspaceManager(config.workspaceRoot))

  const orchestrator = new Orchestrator(config, tracker, webhook, workspace)
  await orchestrator.start()

  const handlers = orchestrator.getHandlers()
  await setOrchestrator({
    getStatus: handlers.getStatus,
    handleWebhook: handlers.onWebhook,
    stop: () => orchestrator.stop(),
    on: (event: string, handler: (...args: unknown[]) => void) => orchestrator.on(event, handler),
    off: (event: string, handler: (...args: unknown[]) => void) => orchestrator.off(event, handler),
  })

  // Graceful shutdown: stop orchestrator and kill agent processes on exit
  const shutdown = async () => {
    logger.info("process", "Received shutdown signal, stopping orchestrator...")
    await orchestrator.stop()
    process.exit(0)
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)

  logger.info("instrumentation", "Symphony Orchestrator initialized")
}
