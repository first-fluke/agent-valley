/**
 * Orchestrator bootstrap — Node.js only.
 * Separated from instrumentation.ts to avoid Edge Runtime static analysis warnings.
 */

import { toOrchestratorConfig } from "@/lib/env"
import { createObservabilityHooks } from "@agent-valley/core/observability/hooks"
import { configureLogger, logger } from "@agent-valley/core/observability/logger"
import { createOtelExporter } from "@agent-valley/core/observability/otel-exporter"
import { createPromMetrics } from "@agent-valley/core/observability/prom-metrics"
import { Orchestrator } from "@agent-valley/core/orchestrator/orchestrator"
import { GithubTrackerAdapter } from "@agent-valley/core/tracker/adapters/github-adapter"
import { GithubWebhookReceiver } from "@agent-valley/core/tracker/adapters/github-webhook-receiver"
import { LinearTrackerAdapter } from "@agent-valley/core/tracker/adapters/linear-adapter"
import { LinearWebhookReceiver } from "@agent-valley/core/tracker/adapters/linear-webhook-receiver"
import { FileSystemWorkspaceGateway } from "@agent-valley/core/workspace/adapters/fs-workspace-gateway"
import { WorkspaceManager } from "@agent-valley/core/workspace/workspace-manager"
import { setMetricsEndpoint } from "@/lib/metrics-singleton"
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

  const tracker =
    config.trackerKind === "github" && config.github
      ? new GithubTrackerAdapter({
          token: config.github.token,
          owner: config.github.owner,
          repo: config.github.repo,
          labels: config.github.labels,
        })
      : new LinearTrackerAdapter({
          apiKey: config.linearApiKey,
          teamId: config.linearTeamId,
          teamUuid: config.linearTeamUuid,
        })
  const webhook =
    config.trackerKind === "github" && config.github
      ? new GithubWebhookReceiver({
          secret: config.github.webhookSecret,
          labels: config.github.labels,
        })
      : new LinearWebhookReceiver({
          secret: config.linearWebhookSecret,
          workflowStates: config.workflowStates,
        })
  const workspace = new FileSystemWorkspaceGateway(new WorkspaceManager(config.workspaceRoot))

  // Observability — both OTel and Prometheus are opt-in via valley.yaml.
  // When disabled (default), the hooks become zero-cost no-ops.
  const metrics = createPromMetrics({ enabled: config.observability.prometheus.enabled })
  const otel = createOtelExporter({
    enabled: config.observability.otel.enabled,
    endpoint: config.observability.otel.endpoint,
    serviceName: config.observability.otel.serviceName,
    metrics,
  })
  const observability = createObservabilityHooks({ metrics, otel })
  setMetricsEndpoint({
    enabled: config.observability.prometheus.enabled,
    path: config.observability.prometheus.path,
    metrics,
  })

  const orchestrator = new Orchestrator(config, tracker, webhook, workspace, undefined, observability)
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
    await otel.shutdown()
    process.exit(0)
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)

  logger.info("instrumentation", "Symphony Orchestrator initialized")
}
