/**
 * Integration test — agent failure → retry queue → cancellation.
 *
 * Routes a failing fake agent through the orchestrator's retry pipeline.
 * With `agentRetryDelay: 0`, the WebhookRouter drains the retry queue
 * synchronously after dispatch (see orchestrator/webhook-router.ts §
 * `await core.processRetryQueue()`), so one webhook post drives both the
 * first failure (retry queued) and the second failure (cap exceeded →
 * cancellation) in a deterministic sequence.
 *
 * Scope (v0.2 M3):
 *   - Two attempts observed (two FakeAgentSession instances)
 *   - retryQueueSize grows on first failure (observed via intermediate
 *     status mid-drain) and shrinks back to 0 after exhaustion
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
let retrySizeHighWaterMark = 0

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
        // Sample the retryQueueSize right after the error is emitted and
        // the completion handler has been synchronously invoked. This is
        // the observation window between "N-th failure queued" and
        // "(N+1)-th attempt starts".
        queueMicrotask(() => {
          const status = rig.orchestrator.getHandlers().getStatus() as { retryQueueSize: number }
          retrySizeHighWaterMark = Math.max(retrySizeHighWaterMark, status.retryQueueSize)
        })
      })
    }
    return session
  })
}

beforeEach(async () => {
  FakeAgentSession.resetRegistry()
  retrySizeHighWaterMark = 0
  repo = await createGitRepo()
  // agentMaxRetries=2 → 1st failure queues (count=1). WebhookRouter drains
  // the queue after dispatch (delay=0 → nextRetryAt is now) → 2nd failure
  // hits count=2 which equals the cap → addRetry returns false → cancel.
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

    // Both attempts should have spawned — the router drains the retry queue
    // (retry delay = 0 makes nextRetryAt <= now) after the initial dispatch.
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

    // The retry queue must have grown past 0 between attempts and then
    // drained back to 0 once the cap was exceeded.
    expect(retrySizeHighWaterMark).toBeGreaterThanOrEqual(1)

    const finalStatus = rig.orchestrator.getHandlers().getStatus() as {
      activeWorkspaces: unknown[]
      retryQueueSize: number
    }
    expect(finalStatus.activeWorkspaces).toHaveLength(0)
    expect(finalStatus.retryQueueSize).toBe(0)
  }, 15_000)
})
