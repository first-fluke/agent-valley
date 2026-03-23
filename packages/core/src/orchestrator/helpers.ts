/**
 * Orchestrator Helpers — Pure functions extracted to keep orchestrator.ts under 500 lines.
 */

import type { Config } from "../config/env"
import type { DagNode, Issue, OrchestratorRuntimeState, RunAttempt } from "../domain/models"
import type { AgentRunnerService } from "./agent-runner"
import type { RetryQueue } from "./retry-queue"

export function buildWorkSummary(
  attempt: RunAttempt,
  opts?: { autoCommitted?: boolean; diffStat?: string | null },
): string {
  const output = attempt.agentOutput ?? "No output captured"
  const duration =
    attempt.finishedAt && attempt.startedAt
      ? Math.round((new Date(attempt.finishedAt).getTime() - new Date(attempt.startedAt).getTime()) / 1000)
      : 0

  const lines = [`Symphony: Work completed`, ``, `**Duration:** ${duration}s`, `**Exit code:** ${attempt.exitCode}`]

  if (opts?.autoCommitted) {
    lines.push(`**Auto-committed:** Yes (agent left uncommitted changes)`)
  }
  if (opts?.diffStat) {
    lines.push(`**Changes:** ${opts.diffStat}`)
  }

  lines.push(``, `### Agent Output`)
  lines.push(output.length > 4000 ? `${output.slice(0, 4000)}\n...(truncated)` : output)

  return lines.join("\n")
}

export function sortByIssueNumber(issues: Issue[]): void {
  issues.sort((a, b) => {
    const numA = Number.parseInt(a.identifier.split("-")[1] ?? "0", 10)
    const numB = Number.parseInt(b.identifier.split("-")[1] ?? "0", 10)
    return numA - numB
  })
}

// Cache system metrics to avoid calling process.memoryUsage()/cpuUsage() on every poll
let cachedMetrics: {
  memoryRss: number
  memoryHeapUsed: number
  memoryHeapTotal: number
  cpuUser: number
  cpuSystem: number
  uptime: number
} | null = null
let metricsTimestamp = 0
const METRICS_TTL_MS = 5000

function getSystemMetrics() {
  const now = Date.now()
  if (cachedMetrics && now - metricsTimestamp < METRICS_TTL_MS) {
    return { ...cachedMetrics, uptime: process.uptime() }
  }

  const mem = process.memoryUsage()
  const cpu = process.cpuUsage()
  cachedMetrics = {
    memoryRss: mem.rss,
    memoryHeapUsed: mem.heapUsed,
    memoryHeapTotal: mem.heapTotal,
    cpuUser: cpu.user,
    cpuSystem: cpu.system,
    uptime: process.uptime(),
  }
  metricsTimestamp = now
  return cachedMetrics
}

export function buildOrchestratorStatus(
  state: OrchestratorRuntimeState,
  activeAttempts: Map<string, string>,
  agentRunner: AgentRunnerService,
  retryQueue: RetryQueue,
  config: Config,
): Record<string, unknown> {
  const workspaces = Array.from(state.activeWorkspaces.entries()).map(([id, ws]) => {
    const attemptId = activeAttempts.get(id)
    return {
      issueId: id,
      key: ws.key,
      status: ws.status,
      startedAt: ws.createdAt,
      lastOutput: attemptId ? agentRunner.getLastOutput(attemptId) : undefined,
    }
  })

  return {
    isRunning: state.isRunning,
    lastEventAt: state.lastEventAt,
    activeWorkspaces: workspaces,
    activeAgents: agentRunner.activeCount,
    waitingIssues: state.waitingIssues.size,
    retryQueueSize: retryQueue.size,
    config: {
      agentType: config.agentType,
      maxParallel: config.maxParallel,
      serverPort: config.serverPort,
    },
    systemMetrics: getSystemMetrics(),
  }
}

export function buildParentSummary(children: DagNode[]): string {
  const lines = ["Symphony: All sub-issues completed", ""]
  for (const child of children) {
    lines.push(`- **${child.identifier}**: ${child.status}`)
  }
  return lines.join("\n")
}
