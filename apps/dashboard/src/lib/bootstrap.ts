/**
 * Orchestrator bootstrap — Node.js only.
 * Separated from instrumentation.ts to avoid Edge Runtime static analysis warnings.
 */

import { toOrchestratorConfig } from "@/lib/env"
import { configureLogger, logger } from "@agent-valley/core/observability/logger"
import { Orchestrator } from "@agent-valley/core/orchestrator/orchestrator"
import { setOrchestrator } from "@/lib/orchestrator-singleton"
import { resolveProjectRoot } from "@/lib/project-root"

export async function bootstrap() {
  // Resolve project root: works in both dev (apps/dashboard/src/lib/) and standalone (.next/standalone/apps/dashboard/)
  // Walk up until we find WORKFLOW.md, regardless of standalone nesting depth.
  const projectRoot = await resolveProjectRoot(process.cwd())
  process.chdir(projectRoot)

  // Prevent orchestrator errors from crashing the Next.js process
  process.on("uncaughtException", (err) => {
    logger.error("process", `Uncaught exception (non-fatal): ${err.message}`, { stack: err.stack })
  })
  process.on("unhandledRejection", (reason) => {
    logger.error("process", `Unhandled rejection (non-fatal): ${reason}`)
  })

  const config = toOrchestratorConfig()
  configureLogger(config.logLevel, config.logFormat)

  const orchestrator = new Orchestrator(config)
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
