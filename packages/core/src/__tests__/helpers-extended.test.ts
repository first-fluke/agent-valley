/**
 * Extended helpers tests — sortByIssueNumber, buildParentSummary,
 * buildOrchestratorStatus, and getSystemMetrics (via _resetMetricsCache).
 */
import { describe, expect, test } from "vitest"
import type { Config } from "../config/yaml-loader"
import type { DagNode, Issue, OrchestratorRuntimeState } from "../domain/models"
import type { AgentRunnerService } from "../orchestrator/agent-runner"
import {
  _resetMetricsCache,
  buildOrchestratorStatus,
  buildParentSummary,
  sortByIssueNumber,
} from "../orchestrator/helpers"
import type { RetryQueue } from "../orchestrator/retry-queue"

// ── sortByIssueNumber ───────────────────────────────────────────────

function makeIssue(identifier: string): Issue {
  return {
    id: `id-${identifier}`,
    identifier,
    title: `Issue ${identifier}`,
    description: "",
    url: "",
    status: { id: "s1", name: "Todo", type: "unstarted" },
    team: { id: "t1", key: "PROJ" },
    labels: [],
    score: null,
    parentId: null,
    children: [],
    relations: [],
  }
}

describe("sortByIssueNumber", () => {
  test("sorts issues by numeric part of identifier", () => {
    const issues = [makeIssue("PROJ-10"), makeIssue("PROJ-2"), makeIssue("PROJ-1"), makeIssue("PROJ-5")]
    sortByIssueNumber(issues)

    expect(issues.map((i) => i.identifier)).toEqual(["PROJ-1", "PROJ-2", "PROJ-5", "PROJ-10"])
  })

  test("handles single issue", () => {
    const issues = [makeIssue("PROJ-1")]
    sortByIssueNumber(issues)
    expect(issues).toHaveLength(1)
  })

  test("handles empty array", () => {
    const issues: Issue[] = []
    sortByIssueNumber(issues)
    expect(issues).toEqual([])
  })

  test("handles identifiers without numbers", () => {
    const issues = [makeIssue("PROJ-abc"), makeIssue("PROJ-1")]
    sortByIssueNumber(issues)
    // NaN handling - NaN compares as 0
    expect(issues).toHaveLength(2)
  })
})

// ── buildParentSummary ──────────────────────────────────────────────

describe("buildParentSummary", () => {
  test("generates summary with child statuses", () => {
    const children: DagNode[] = [
      { issueId: "i1", identifier: "PROJ-1", status: "done", children: [], parentId: null, blockedBy: [], blocks: [] },
      { issueId: "i2", identifier: "PROJ-2", status: "done", children: [], parentId: null, blockedBy: [], blocks: [] },
    ]

    const result = buildParentSummary(children)

    expect(result).toContain("Symphony: All sub-issues completed")
    expect(result).toContain("**PROJ-1**: done")
    expect(result).toContain("**PROJ-2**: done")
  })

  test("handles empty children array", () => {
    const result = buildParentSummary([])
    expect(result).toContain("Symphony: All sub-issues completed")
  })
})

// ── buildOrchestratorStatus ─────────────────────────────────────────

describe("buildOrchestratorStatus", () => {
  function makeState(): OrchestratorRuntimeState {
    return {
      isRunning: true,
      lastEventAt: "2026-03-22T00:00:00.000Z",
      activeWorkspaces: new Map([
        [
          "issue-1",
          {
            issueId: "issue-1",
            path: "/workspace/PROJ-1",
            key: "PROJ-1",
            branch: "feature/PROJ-1",
            status: "running",
            createdAt: "2026-03-22T00:00:00.000Z",
          },
        ],
      ]),
      waitingIssues: new Map(),
    }
  }

  function makeConfig(): Config {
    return {
      trackerKind: "linear",
      linearApiKey: "key",
      linearTeamId: "PROJ",
      linearTeamUuid: "uuid",
      linearWebhookSecret: "secret",
      workflowStates: { todo: "s1", inProgress: "s2", done: "s3", cancelled: "s4" },
      workspaceRoot: "/workspace",
      agentType: "claude",
      agentTimeout: 3600,
      agentMaxRetries: 3,
      agentRetryDelay: 60,
      maxParallel: 2,
      serverPort: 9741,
      logLevel: "info",
      logFormat: "json",
      deliveryMode: "merge",
      routingRules: [],
      promptTemplate: "test",
    } as Config
  }

  function mockRunner(overrides: Partial<Pick<AgentRunnerService, "activeCount" | "getLastOutput">> = {}) {
    return {
      activeCount: overrides.activeCount ?? 0,
      getLastOutput: overrides.getLastOutput ?? (() => undefined),
    } as AgentRunnerService
  }

  function mockRetryQueue(size = 0) {
    return { size } as RetryQueue
  }

  test("builds status with active workspaces", () => {
    _resetMetricsCache()

    const state = makeState()
    const activeAttempts = new Map([["issue-1", "attempt-1"]])

    const status = buildOrchestratorStatus(
      state,
      activeAttempts,
      mockRunner({ activeCount: 1, getLastOutput: () => "last output" }),
      mockRetryQueue(0),
      makeConfig(),
    )

    expect(status.isRunning).toBe(true)
    const workspaces = status.activeWorkspaces as Array<Record<string, unknown>>
    expect(workspaces.length).toBe(1)
    expect(workspaces[0]?.key).toBe("PROJ-1")
    expect(workspaces[0]?.lastOutput).toBe("last output")
    expect(status.activeAgents).toBe(1)
    expect(status.retryQueueSize).toBe(0)
    const cfg = status.config as Record<string, unknown>
    expect(cfg.agentType).toBe("claude")
    expect(cfg.maxParallel).toBe(2)
    expect(status.systemMetrics).toBeDefined()
  })

  test("workspace without active attempt has no lastOutput", () => {
    _resetMetricsCache()

    const state = makeState()
    const activeAttempts = new Map<string, string>()

    const status = buildOrchestratorStatus(state, activeAttempts, mockRunner(), mockRetryQueue(2), makeConfig())

    const workspaces = status.activeWorkspaces as Array<Record<string, unknown>>
    expect(workspaces[0]?.lastOutput).toBeUndefined()
    expect(status.retryQueueSize).toBe(2)
  })

  test("system metrics include expected fields", () => {
    _resetMetricsCache()

    const state = makeState()
    const status = buildOrchestratorStatus(state, new Map(), mockRunner(), mockRetryQueue(), makeConfig())

    const metrics = status.systemMetrics as Record<string, unknown>
    expect(metrics.memoryRss).toBeTypeOf("number")
    expect(metrics.memoryTotal).toBeTypeOf("number")
    expect(metrics.cpuUser).toBeTypeOf("number")
    expect(metrics.uptime).toBeTypeOf("number")
  })

  test("system metrics are cached within TTL", () => {
    _resetMetricsCache()

    const state = makeState()
    const runner = mockRunner()
    const queue = mockRetryQueue()
    const config = makeConfig()

    const status1 = buildOrchestratorStatus(state, new Map(), runner, queue, config)
    const status2 = buildOrchestratorStatus(state, new Map(), runner, queue, config)

    expect(status1.systemMetrics).toBeDefined()
    expect(status2.systemMetrics).toBeDefined()
  })
})
