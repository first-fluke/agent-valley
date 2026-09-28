/**
 * Integration test — agent failure → retry queue → cancellation.
 *
 * Routes a failing fake agent through the orchestrator's retry pipeline.
 * With `agentRetryDelay: 0`, the test waits for the asynchronous failure
 * handler to queue the retry, then drains it through the same core method
 * used by the orchestrator's periodic retry scheduler.
 *
 * Scope (v0.2 M3):
 *   - Two attempts observed (two FakeAgentSession instances)
 *   - retryQueueSize grows on first failure and shrinks back to 0
 *     after exhaustion
 *   - Tracker receives updateIssueState(cancelled) + actionable error comment
 *   - activeWorkspaces drains to 0 at the end
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { registerSession } from "../../sessions/session-factory"
import { FakeAgentSession } from "../characterization/helpers"
import {
  buildOrchestratorRig,
  createGitRepo,
  makeIssuePayload,
  type OrchestratorRig,
  type RepoHandle,
  waitFor,
} from "./helpers"

vi.mock("../../sessions/session-factory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sessions/session-factory")>()
  return {
    ...actual,
    registerBuiltinSessions: vi.fn(async () => undefined),
  }
})

let repo: RepoHandle
let rig: OrchestratorRig

// Register a failing fake claude session — each execute() emits a recoverable
// error so the orchestrator retry/cancel pipeline can fire.
function registerFailingClaude(errorMessage = "integration-induced failure"): void {
  registerSession("claude", () => {
    const session = new FakeAgentSession()
    const originalExecute = session.execute.bind(session)
    session.execute = async (prompt: string) => {
      await originalExecute(prompt)
      queueMicrotask(() => {
        session.emit("error", {
          type: "error",
          error: { code: "CRASH", message: errorMessage, recoverable: true },
        })
      })
    }
    return session
  })
}

beforeEach(async () => {
  FakeAgentSession.resetRegistry()
  repo = await createGitRepo()
  // agentMaxRetries=2 → 1st failure queues (count=1). The test drains
  // the ready queue after observing it; the 2nd failure reaches the cap
  // and cancels the issue.
  rig = buildOrchestratorRig({
    workspaceRoot: repo.repoDir,
    overrides: { agentMaxRetries: 2, agentRetryDelay: 0, maxParallel: 2 },
  })
  registerFailingClaude()
})

afterEach(async () => {
  await rig.stop()
  await repo.cleanup()
  vi.restoreAllMocks()
})

describe("Integration — agent failure retry exhaustion", () => {
  test("first failure queues a retry; max-retries path cancels with error comment", async () => {
    const issueId = "issue-integ-retry"
    const identifier = "INT-RX-1"
    const payload = makeIssuePayload(rig.config, {
      id: issueId,
      identifier,
      title: "feat: retry-exhaust",
      toState: "inProgress",
      fromState: "todo",
    })

    // Seed the fake tracker so processRetryQueue() finds the issue at drain time.
    rig.tracker.seedIssue({
      id: issueId,
      identifier,
      title: "feat: retry-exhaust",
      description: "",
      status: {
        id: rig.config.workflowStates.inProgress,
        name: "In Progress",
        type: "started",
      },
      team: { id: "team-uuid", key: "PROJ" },
      labels: [],
      url: `https://linear.app/test/issue/${identifier}`,
      score: null,
      parentId: null,
      children: [],
      relations: [],
    })

    const response = await rig.post(payload)
    expect(response.status).toBe(200)

    // The fake emits its failure in a microtask after the webhook router's
    // immediate queue drain, so wait for the observable queue state before
    // invoking the scheduler path.
    const queuedSize = await waitFor(
      () => (rig.orchestrator.getHandlers().getStatus() as { retryQueueSize: number }).retryQueueSize,
      { timeoutMs: 4_000, description: "first failure queued for retry" },
    )
    expect(queuedSize).toBeGreaterThanOrEqual(1)
    // The facade does not expose the periodic scheduler hook, so this
    // integration test invokes its core method directly after the queue is ready.
    const core = rig.orchestrator as unknown as { core: { processRetryQueue: () => Promise<void> } }
    await core.core.processRetryQueue()

    // Both attempts should now have spawned.
    await waitFor(() => FakeAgentSession.instances.length >= 2, {
      timeoutMs: 4_000,
      description: "two agent sessions spawned (initial + retry)",
    })

    // Cancellation path must produce a tracker write + actionable comment.
    await waitFor(
      () =>
        rig.tracker.calls.some(
          (c) => c.method === "updateIssueState" && c.args[1] === rig.config.workflowStates.cancelled,
        ),
      { timeoutMs: 4_000, description: "updateIssueState(cancelled) after max retries" },
    )

    const comments = rig.tracker.comments.get(issueId) ?? []
    const exhaustion = comments.find((c) => /retries exceeded/i.test(c))
    expect(exhaustion).toBeDefined()
    expect(exhaustion).toContain("integration-induced failure")

    // The retry queue drained back to 0 once the cap was exceeded.

    const finalStatus = rig.orchestrator.getHandlers().getStatus() as {
      activeWorkspaces: unknown[]
      retryQueueSize: number
    }
    expect(finalStatus.activeWorkspaces).toHaveLength(0)
    expect(finalStatus.retryQueueSize).toBe(0)
  }, 15_000)
})
