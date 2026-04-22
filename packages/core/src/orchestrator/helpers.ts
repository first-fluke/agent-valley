/**
 * Orchestrator Helpers — Pure functions extracted to keep orchestrator.ts under 500 lines.
 */

import { execSync } from "node:child_process"
import { cpus, freemem, platform, totalmem } from "node:os"
import type { Config } from "../config/yaml-loader"
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

// Cache system metrics with TTL to avoid expensive syscalls on every SSE poll
let cachedMetrics: {
  memoryRss: number
  memoryTotal: number
  cpuUser: number
  uptime: number
} | null = null
let metricsTimestamp = 0
let prevCpuTimes: { idle: number; total: number } | null = null
const METRICS_TTL_MS = 5000

function getMemoryUsed(): number {
  if (platform() === "darwin") {
    try {
      const output = execSync("vm_stat", { encoding: "utf8" })
      const pageSizeMatch = output.match(/page size of (\d+)/)
      const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 16384
      const get = (key: string) => {
        const m = output.match(new RegExp(`${key}:\\s+(\\d+)`))
        return m ? Number(m[1]) : 0
      }
      return (get("Pages active") + get("Pages wired down") + get("Pages occupied by compressor")) * pageSize
    } catch {
      // fall through
    }
  }
  return totalmem() - freemem()
}

function snapshotCpuTimes() {
  let idle = 0
  let total = 0
  for (const core of cpus()) {
    idle += core.times.idle
    total += core.times.user + core.times.nice + core.times.sys + core.times.irq + core.times.idle
  }
  return { idle, total }
}

/** @internal test-only — resets the metrics cache */
export function _resetMetricsCache() {
  cachedMetrics = null
  metricsTimestamp = 0
  prevCpuTimes = snapshotCpuTimes()
}

function getSystemMetrics() {
  const now = Date.now()
  if (cachedMetrics && now - metricsTimestamp < METRICS_TTL_MS) {
    return { ...cachedMetrics, uptime: process.uptime() }
  }

  const cur = snapshotCpuTimes()

  let cpuPct = 0
  if (prevCpuTimes) {
    const totalDelta = cur.total - prevCpuTimes.total
    const idleDelta = cur.idle - prevCpuTimes.idle
    if (totalDelta > 0) {
      cpuPct = Math.round(((totalDelta - idleDelta) / totalDelta) * 100)
    }
  }
  prevCpuTimes = cur

  cachedMetrics = {
    memoryRss: getMemoryUsed(),
    memoryTotal: totalmem(),
    cpuUser: cpuPct,
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
      // Exposed so the dashboard InterventionPanel can target the
      // running session without an extra /api/status round-trip.
      // Design: docs/plans/v0-2-bigbang-design.md § 5.7.
      attemptId,
      agentType: attemptId ? agentRunner.getAgentType(attemptId) : undefined,
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
