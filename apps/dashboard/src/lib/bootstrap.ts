/**
 * Orchestrator bootstrap — Node.js only.
 * Separated from instrumentation.ts to avoid Edge Runtime static analysis warnings.
 */

import path from "node:path"
import { toOrchestratorConfig } from "@/lib/env"
import { configureLogger, logger } from "@agent-valley/core/observability/logger"
import { Orchestrator } from "@agent-valley/core/orchestrator/orchestrator"
import { setOrchestrator } from "@/lib/orchestrator-singleton"

export async function bootstrap() {
  // Resolve project root from known location (apps/dashboard/) rather than relying on CWD
  const projectRoot = path.resolve(__dirname, "../../../..")
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
    on: (event, handler) => orchestrator.on(event, handler),
    off: (event, handler) => orchestrator.off(event, handler),
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
