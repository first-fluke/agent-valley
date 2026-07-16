/**
 * applyRecoveryDecision unit tests — mutation of live runtime Maps.
 */

import { describe, expect, test } from "vitest"
import type { OrchestratorRuntimeState } from "../domain/models"
import { createNoopObservabilityHooks } from "../observability/hooks"
import { applyRecoveryDecision } from "../orchestrator/persistence/recovery-apply"
import type { PersistedAttempt } from "../orchestrator/persistence/run-state-store"
import { RetryQueue } from "../orchestrator/retry-queue"

function makeState(): OrchestratorRuntimeState {
  return { isRunning: false, activeWorkspaces: new Map(), waitingIssues: new Map(), lastEventAt: null }
}

function makeAttempt(overrides: Partial<PersistedAttempt> = {}): PersistedAttempt {
  return {
    issueId: "issue-1",
    attemptId: "attempt-1",
    workspacePath: "/ws/issue-1",
    pid: null,
    startedAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  }
}

function makeDeps() {
  return {
    state: makeState(),
    activeAttempts: new Map<string, string>(),
    attemptStartedAt: new Map<string, string>(),
    retryQueue: new RetryQueue(3, 60),
    observability: createNoopObservabilityHooks(),
  }
}

describe("applyRecoveryDecision — reattach", () => {
  test("rehydrates activeAttempts + a placeholder Workspace so canAcceptIssue blocks a duplicate spawn", () => {
    const deps = makeDeps()
    const attempt = makeAttempt()

    applyRecoveryDecision({ reattach: [attempt], reap: [], restoredRetries: [] }, deps)

    expect(deps.activeAttempts.get("issue-1")).toBe("attempt-1")
    expect(deps.attemptStartedAt.get("issue-1")).toBe(attempt.startedAt)
    const ws = deps.state.activeWorkspaces.get("issue-1")
    expect(ws).toBeDefined()
    expect(ws?.path).toBe("/ws/issue-1")
    expect(ws?.status).toBe("running")
  })

  test("does not overwrite an already-present activeWorkspaces entry", () => {
    const deps = makeDeps()
    deps.state.activeWorkspaces.set("issue-1", {
      issueId: "issue-1",
      path: "/real/path",
      key: "PROJ-1",
      branch: "symphony/PROJ-1",
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
    })

    applyRecoveryDecision({ reattach: [makeAttempt()], reap: [], restoredRetries: [] }, deps)

    expect(deps.state.activeWorkspaces.get("issue-1")?.path).toBe("/real/path")
  })
})

describe("applyRecoveryDecision — reap", () => {
  test("clears stale bookkeeping so startup sync can safely restart the issue", () => {
    const deps = makeDeps()
    deps.activeAttempts.set("issue-1", "attempt-1")
    deps.attemptStartedAt.set("issue-1", "2026-07-16T00:00:00.000Z")
    deps.state.activeWorkspaces.set("issue-1", {
      issueId: "issue-1",
      path: "/ws/issue-1",
      key: "PROJ-1",
      branch: "b",
      status: "running",
      createdAt: "2026-07-16T00:00:00.000Z",
    })

    applyRecoveryDecision({ reattach: [], reap: [makeAttempt()], restoredRetries: [] }, deps)

    expect(deps.activeAttempts.has("issue-1")).toBe(false)
    expect(deps.attemptStartedAt.has("issue-1")).toBe(false)
    expect(deps.state.activeWorkspaces.has("issue-1")).toBe(false)
  })
})

describe("applyRecoveryDecision — retry queue restore", () => {
  test("re-adds persisted retry entries to the live RetryQueue", () => {
    const deps = makeDeps()
    applyRecoveryDecision(
      {
        reattach: [],
        reap: [],
        restoredRetries: [{ issueId: "x", attemptCount: 1, nextRetryAt: "t", lastError: "e" }],
      },
      deps,
    )
    expect(deps.retryQueue.size).toBe(1)
    expect(deps.retryQueue.entries[0]?.issueId).toBe("x")
  })
})

describe("applyRecoveryDecision — summary", () => {
  test("returns accurate counts", () => {
    const deps = makeDeps()
    const summary = applyRecoveryDecision(
      {
        reattach: [makeAttempt({ issueId: "a" })],
        reap: [makeAttempt({ issueId: "b" }), makeAttempt({ issueId: "c" })],
        restoredRetries: [{ issueId: "d", attemptCount: 1, nextRetryAt: "t", lastError: "e" }],
      },
      deps,
    )
    expect(summary).toEqual({ reattached: 1, reaped: 2, restoredRetries: 1 })
  })
})
