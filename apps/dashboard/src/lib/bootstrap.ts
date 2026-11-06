/**
 * Orchestrator bootstrap — Node.js only.
 * Separated from instrumentation.ts to avoid Edge Runtime static analysis warnings.
 */

import { createObservabilityHooks } from "@agent-valley/core/observability/hooks"
import { configureLogger, logger } from "@agent-valley/core/observability/logger"
import { createOtelExporter } from "@agent-valley/core/observability/otel-exporter"
import { createPromMetrics } from "@agent-valley/core/observability/prom-metrics"
import { createInMemoryBudgetService, createNoopBudgetService } from "@agent-valley/core/orchestrator/budget-service"
import { Orchestrator } from "@agent-valley/core/orchestrator/orchestrator"
import type { LedgerBridge } from "@agent-valley/core/relay/ledger-bridge"
import { wireLedgerRelay } from "@agent-valley/core/relay/ledger-wiring"
import { openStateStores } from "@agent-valley/core/state/open-state-stores"
import { GithubTrackerAdapter } from "@agent-valley/core/tracker/adapters/github-adapter"
import { GithubReviewWebhookReceiver } from "@agent-valley/core/tracker/adapters/github-review-webhook-receiver"
import { GithubWebhookReceiver } from "@agent-valley/core/tracker/adapters/github-webhook-receiver"
import { LinearTrackerAdapter } from "@agent-valley/core/tracker/adapters/linear-adapter"
import { LinearWebhookReceiver } from "@agent-valley/core/tracker/adapters/linear-webhook-receiver"
import { FileSystemWorkspaceGateway } from "@agent-valley/core/workspace/adapters/fs-workspace-gateway"
import { GhCliCodeHost } from "@agent-valley/core/workspace/adapters/gh-code-host"
import { ensureRuntimeGitignore } from "@agent-valley/core/workspace/runtime-ignore"
import { WorkspaceManager } from "@agent-valley/core/workspace/workspace-manager"
import { toOrchestratorConfig } from "@/lib/env"
import { setMetricsEndpoint } from "@/lib/metrics-singleton"
import { initializeOrchestrator, type OrchestratorInstance } from "@/lib/orchestrator-singleton"
import { resolveProjectRoot } from "@/lib/project-root"

export function bootstrap(): Promise<void> {
  return initializeOrchestrator(startOrchestrator)
}

async function startOrchestrator(): Promise<OrchestratorInstance> {
  // Resolve project root: walk up until we find av.yaml
  const projectRoot = await resolveProjectRoot(process.cwd())
  process.chdir(projectRoot)

  const config = toOrchestratorConfig(projectRoot)
  for (const root of new Set([projectRoot, config.workspaceRoot])) await ensureRuntimeGitignore(root)
  configureLogger(config.logLevel, config.logFormat)

  // Every durable record lives in `.agent-valley/state.db`; earlier JSON
  // snapshots are imported on first boot.
  const stateStores = await openStateStores(`${config.workspaceRoot}/.agent-valley`)

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
          dedupCache: stateStores.dedupCache,
        })
      : new LinearWebhookReceiver({
          secret: config.linearWebhookSecret,
          workflowStates: config.workflowStates,
          dedupCache: stateStores.dedupCache,
        })
  const workspace = new FileSystemWorkspaceGateway(new WorkspaceManager(config.workspaceRoot))

  // Observability — both OTel and Prometheus are opt-in via av.yaml.
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

  // Budget service — configured via av.yaml budget: section. When the
  // section is absent the no-op service is used so spawn is never gated.
  // Design § 4.5 / § 6.4 (E16–E19). Counters live in the state database
  // so a process restart cannot silently reset today's daily USD/token
  // cap — `ready` is awaited below before the orchestrator can accept its
  // first issue.
  const budget = config.budget
    ? createInMemoryBudgetService({ caps: config.budget, observability, persistence: stateStores.budgetUsage })
    : createNoopBudgetService()
  if (budget.ready) await budget.ready

  const orchestrator = new Orchestrator(
    config,
    tracker,
    webhook,
    workspace,
    undefined,
    observability,
    budget,
    undefined,
    {
      runState: stateStores.runState,
      dagCache: stateStores.dagCache,
    },
  )
  const githubTracker = config.trackerKind === "github" && Boolean(config.github)
  // Pull requests live on GitHub whichever service tracks the issues. The
  // GitHub tracker's receiver already parses reviews; other trackers get a
  // review-only receiver on /api/webhook/github.
  if (config.pullRequestReviews?.enabled) {
    orchestrator.attachCodeHost({
      client: new GhCliCodeHost(),
      webhook: githubTracker
        ? undefined
        : new GithubReviewWebhookReceiver({
            secret: config.pullRequestReviews.webhookSecret,
            dedupCache: stateStores.dedupCache,
          }),
    })
  }

  // Team ledger relay — opt-in via av.yaml team: (relay_url + id)
  // and a valid user team token saved by `av login`. Clean no-op
  // (null) for single-node setups or a team config with no session yet;
  // never throws, never blocks boot. Must be wired before start() so the
  // initial node.join event (emitted from OrchestratorCore.start()) is
  // not missed.
  const ledgerBridge: LedgerBridge | null = wireLedgerRelay(orchestrator, config)

  const stop = async () => {
    process.off("SIGTERM", shutdown)
    process.off("SIGINT", shutdown)
    try {
      await orchestrator.stop()
    } finally {
      try {
        if (ledgerBridge) await ledgerBridge.dispose()
      } finally {
        try {
          await otel.shutdown()
        } finally {
          await stateStores.close()
        }
      }
    }
  }

  // Graceful shutdown: stop orchestrator and kill agent processes on exit
  const shutdown = async () => {
    logger.info("process", "Received shutdown signal, stopping orchestrator...")
    await stop()
    process.exit(0)
  }

  try {
    await orchestrator.start()
  } catch (error) {
    await stop()
    throw error
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)

  logger.info("instrumentation", "Symphony Orchestrator initialized")
  const handlers = orchestrator.getHandlers()
  return {
    getStatus: handlers.getStatus,
    handleWebhook: handlers.onWebhook,
    handleGithubWebhook: githubTracker ? handlers.onWebhook : handlers.onCodeHostWebhook,
    stop,
    on: (event, handler) => orchestrator.on(event, handler),
    off: (event, handler) => orchestrator.off(event, handler),
    intervention: orchestrator.intervention,
  }
}
