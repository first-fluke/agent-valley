/**
 * System metrics caching regression tests.
 *
 * Ensures buildOrchestratorStatus caches os.cpus()/freemem()/totalmem()
 * calls with a TTL, preventing expensive synchronous syscalls on every
 * SSE poll interval.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { Config } from "../config/yaml-loader"
import type { OrchestratorRuntimeState } from "../domain/models"
import type { AgentRunnerService } from "../orchestrator/agent-runner"
import { _resetMetricsCache, buildOrchestratorStatus } from "../orchestrator/helpers"
import type { RetryQueue } from "../orchestrator/retry-queue"

function makeState(): OrchestratorRuntimeState {
  return {
    isRunning: true,
    lastEventAt: "2026-03-23T00:00:00Z",
    activeWorkspaces: new Map(),
    waitingIssues: new Map(),
  }
}

function makeAgentRunner(): AgentRunnerService {
  return {
    activeCount: 0,
    getLastOutput: () => undefined,
  } as unknown as AgentRunnerService
}

function makeRetryQueue(): RetryQueue {
  return { size: 0 } as unknown as RetryQueue
}

function makeConfig(): Config {
  return {
    trackerKind: "linear",
    agentType: "claude",
    maxParallel: 3,
    serverPort: 9741,
    promptTemplate: "test prompt",
  } as Config
}

interface MetricsResult {
  systemMetrics: { memoryRss: number; memoryTotal: number; cpuUser: number; uptime: number }
}

function callBuild() {
  return buildOrchestratorStatus(
    makeState(),
    new Map(),
    makeAgentRunner(),
    makeRetryQueue(),
    makeConfig(),
  ) as unknown as MetricsResult
}

describe("buildOrchestratorStatus — metrics caching", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    _resetMetricsCache()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test("returns systemMetrics with expected fields", () => {
    const result = callBuild()

    expect(result.systemMetrics).toBeDefined()
    expect(typeof result.systemMetrics.memoryRss).toBe("number")
    expect(typeof result.systemMetrics.memoryTotal).toBe("number")
    expect(typeof result.systemMetrics.cpuUser).toBe("number")
    expect(typeof result.systemMetrics.uptime).toBe("number")
  })

  test("returns cached metrics within TTL window", () => {
    const a = callBuild()
    const b = callBuild()
    const c = callBuild()

    // Same cached object (except uptime) within TTL
    expect(a.systemMetrics.memoryRss).toBe(b.systemMetrics.memoryRss)
    expect(b.systemMetrics.memoryRss).toBe(c.systemMetrics.memoryRss)
    expect(a.systemMetrics.cpuUser).toBe(c.systemMetrics.cpuUser)
  })

  test("refreshes metrics after TTL expires", () => {
    const before = callBuild()

    // Advance past 5s TTL
    vi.advanceTimersByTime(5_001)

    const after = callBuild()

    // uptime should differ since we advanced time
    expect(after.systemMetrics.uptime).toBeGreaterThan(before.systemMetrics.uptime)
  })

  test("rapid polling stays cached", () => {
    const results: number[] = []

    // Simulate 8 rapid polls within TTL
    for (let i = 0; i < 8; i++) {
      const r = callBuild()
      results.push(r.systemMetrics.memoryRss)
    }

    // All return same cached value
    expect(new Set(results).size).toBe(1)
  })
})
