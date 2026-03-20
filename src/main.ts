/**
 * Symphony Orchestrator — Entry Point
 *
 * Usage:
 *   bun run src/main.ts
 */

import { loadConfig } from "./config/config"
import { configureLogger, logger } from "./observability/logger"
import { Orchestrator } from "./orchestrator/orchestrator"
import { startHttpServer } from "./server/http-server"

// Load config (exits on validation failure)
const config = loadConfig()

// Configure logger
configureLogger(config.logLevel, config.logFormat)

// Create and start orchestrator
const orchestrator = new Orchestrator(config)

// Graceful shutdown
let httpServer: { stop: () => void } | null = null

process.on("SIGTERM", async () => {
  logger.info("main", "SIGTERM received")
  httpServer?.stop()
  await orchestrator.stop()
  process.exit(0)
})

process.on("SIGINT", async () => {
  logger.info("main", "SIGINT received")
  httpServer?.stop()
  await orchestrator.stop()
  process.exit(0)
})

// Start
logger.info("main", "Symphony Orchestrator starting...")
await orchestrator.start()

// Start HTTP server (Presentation layer wired to Application layer handlers)
httpServer = startHttpServer(config.serverPort, orchestrator.getHandlers())

logger.info("main", `Symphony ready — listening on :${config.serverPort}`)
