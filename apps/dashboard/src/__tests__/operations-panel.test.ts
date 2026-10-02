import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import type { OrchestratorState } from "@/features/office/types/agent"
import { ActiveAgentsPanel } from "@/features/orchestrator/components/active-agents-panel"
import { OperationsPanel } from "@/features/orchestrator/components/operations-panel"
import { useLocalOrchestrator } from "@/features/team/hooks/use-local-orchestrator"

const state: OrchestratorState = {
  isRunning: true,
  lastEventAt: null,
  activeWorkspaces: [],
  activeAgents: 0,
  retryQueueSize: 0,
  config: { agentType: "codex", maxParallel: 3, serverPort: 9741 },
}

describe("operator dashboard rendering", () => {
  test("shows recovery instructions when bootstrap failed without requiring a config object", () => {
    const html = renderToStaticMarkup(
      createElement(OperationsPanel, {
        state: null,
        connected: true,
        runtimeError: "Run av doctor, then restart av up.",
      }),
    )
    expect(html).toContain("Unavailable")
    expect(html).toContain('role="alert"')
    expect(html).toContain("Run av doctor")
    expect(html).not.toContain("Running")
  })

  test("idle operators see how to submit the first issue", () => {
    const html = renderToStaticMarkup(createElement(OperationsPanel, { state, connected: true, runtimeError: null }))
    expect(html).toContain("No work queued")
    expect(html).toContain("Todo")
  })

  test("disconnected snapshots are not presented as running", () => {
    const html = renderToStaticMarkup(createElement(OperationsPanel, { state, connected: false, runtimeError: null }))
    expect(html).toContain("status may be stale")
    expect(html).not.toContain(">Running<")
  })

  test("renders dependency blockers and escaped retry failure details", () => {
    const waiting = { issueId: "2", identifier: "AV-2", blockedBy: ["AV-1"], enqueuedAt: "2026-03-22T00:00:00Z" }
    const retry = {
      issueId: "3",
      attemptCount: 2,
      nextRetryAt: "2026-03-22T00:05:00Z",
      lastError: "Unauthorized <token>",
      category: "infra" as const,
    }
    const html = renderToStaticMarkup(
      createElement(OperationsPanel, {
        state: { ...state, waitingIssues: 1, waitingIssueDetails: [waiting], retryQueueSize: 1, retryQueue: [retry] },
        connected: true,
        runtimeError: null,
      }),
    )
    expect(html).toContain("AV-2")
    expect(html).toContain("Blocked by AV-1")
    expect(html).toContain("Unauthorized &lt;token&gt;")
    expect(html).toContain("attempt 2")
    expect(html).toContain('dateTime="2026-03-22T00:05:00Z"')
  })

  test("status-only users see active agents with disabled intervention buttons", () => {
    const html = renderToStaticMarkup(
      createElement(ActiveAgentsPanel, {
        workspaces: [
          {
            issueId: "1",
            key: "AV-1",
            status: "running",
            startedAt: "2026-03-22T00:00:00Z",
            attemptId: "attempt-1",
            agentType: "codex",
          },
        ],
        selectedAttemptId: null,
        onSelect: () => {},
        canIntervene: false,
      }),
    )
    expect(html).toContain("AV-1")
    expect(html).toContain("Read-only access")
    expect(html).toContain("disabled")
  })

  test("local team state uses routed agent types and excludes finished workspaces", () => {
    let result: ReturnType<typeof useLocalOrchestrator> | undefined
    function Probe() {
      result = useLocalOrchestrator(
        {
          ...state,
          activeWorkspaces: [
            { issueId: "1", key: "AV-1", status: "running", startedAt: "today", agentType: "claude" },
            { issueId: "2", key: "AV-2", status: "failed", startedAt: "today" },
          ],
        },
        "open",
      )
      return null
    }
    renderToStaticMarkup(createElement(Probe))
    expect(result?.teamState?.nodes[0]?.activeIssues).toEqual([
      { issueId: "1", issueKey: "AV-1", agentType: "claude", startedAt: "today" },
    ])
  })

  test("a closed SSE connection marks the local node offline", () => {
    let result: ReturnType<typeof useLocalOrchestrator> | undefined
    function Probe() {
      result = useLocalOrchestrator(state, "closed")
      return null
    }
    renderToStaticMarkup(createElement(Probe))
    expect(result?.status).toBe("disconnected")
    expect(result?.teamState?.nodes[0]?.online).toBe(false)
  })
})
