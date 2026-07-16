/**
 * OrchestratorCore crash-recovery integration tests — persistence hooks
 * wired into registerAttempt/cleanupState/retry-queue mutators, plus
 * recoverFromPersistedState() boot-recovery behavior.
 *
 * process.kill is mocked so no real PID is ever probed (per task rules:
 * "Mock the filesystem/PID probes; do not spawn real processes").
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { ParsedWebhookEvent } from "../domain/parsed-webhook-event"
import { OrchestratorCore } from "../orchestrator/orchestrator-core"
import { makeConfig, makeIssue, makeWorkspace } from "./characterization/helpers"
import { FakeRunStatePersistence } from "./fakes/fake-run-state-persistence"
import { FakeIssueTracker } from "./fakes/fake-tracker"
import { FakeWebhookReceiver } from "./fakes/fake-webhook-receiver"
import { FakeWorkspaceGateway } from "./fakes/fake-workspace-gateway"

function buildCore(runState = new FakeRunStatePersistence()) {
  const tracker = new FakeIssueTracker()
  const webhook = new FakeWebhookReceiver<ParsedWebhookEvent>()
  const workspace = new FakeWorkspaceGateway()
  const config = makeConfig()
  const core = new OrchestratorCore({
    config,
    tracker,
    webhook,
    workspace,
    emit: () => {},
    runStatePersistence: runState,
  })
  return { core, tracker, workspace, runState }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("OrchestratorCore — persistence on mutation", () => {
  test("registerAttempt mirrors the active attempt to the run-state store", () => {
    const { core, runState } = buildCore()
    const ws = makeWorkspace(makeIssue({ id: "i1" }))
    core.addActiveWorkspace("i1", ws)
    core.registerAttempt("i1", "att-1")

    const last = runState.replaceActiveAttemptsCalls.at(-1)
    expect(last).toEqual([
      expect.objectContaining({ issueId: "i1", attemptId: "att-1", workspacePath: ws.path, pid: null }),
    ])
  })

  test("cleanupState (via buildCompletionDeps) clears the persisted attempt", () => {
    const { core, runState } = buildCore()
    const ws = makeWorkspace(makeIssue({ id: "i1" }))
    core.addActiveWorkspace("i1", ws)
    core.registerAttempt("i1", "att-1")

    core.buildCompletionDeps().cleanupState("i1", "done")

    expect(runState.replaceActiveAttemptsCalls.at(-1)).toEqual([])
  })

  test("enqueueRetry / removeRetry mirror the retry queue to the run-state store", () => {
    const { core, runState } = buildCore()
    core.enqueueRetry("i1", 1, "boom")
    expect(runState.replaceRetryQueueCalls.at(-1)).toEqual([expect.objectContaining({ issueId: "i1" })])

    core.removeRetry("i1")
    expect(runState.replaceRetryQueueCalls.at(-1)).toEqual([])
  })
})

describe("OrchestratorCore — recoverFromPersistedState", () => {
  test("reaps an attempt with no recorded pid — liveness unverifiable — and leaves the slot free", async () => {
    const runState = new FakeRunStatePersistence({
      activeAttempts: [
        {
          issueId: "i1",
          attemptId: "att-1",
          workspacePath: "/ws/i1",
          pid: null,
          startedAt: "2026-07-16T00:00:00.000Z",
        },
      ],
    })
    const { core } = buildCore(runState)

    await core.recoverFromPersistedState()

    expect(core.canAcceptIssue("i1")).toEqual({ ok: true })
    expect(core.getAttempt("i1")).toBeUndefined()
  })

  test("reaps an attempt whose pid probe reports dead", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("kill ESRCH") as NodeJS.ErrnoException
      err.code = "ESRCH"
      throw err
    })
    const runState = new FakeRunStatePersistence({
      activeAttempts: [
        {
          issueId: "i1",
          attemptId: "att-1",
          workspacePath: "/ws/i1",
          pid: 99999,
          startedAt: "2026-07-16T00:00:00.000Z",
        },
      ],
    })
    const { core } = buildCore(runState)

    await core.recoverFromPersistedState()

    expect(core.canAcceptIssue("i1")).toEqual({ ok: true })
  })

  test("reattaches an attempt whose pid probe reports alive, blocking a duplicate spawn", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true)
    const runState = new FakeRunStatePersistence({
      activeAttempts: [
        { issueId: "i1", attemptId: "att-1", workspacePath: "/ws/i1", pid: 111, startedAt: "2026-07-16T00:00:00.000Z" },
      ],
    })
    const { core } = buildCore(runState)

    await core.recoverFromPersistedState()

    expect(core.canAcceptIssue("i1")).toEqual({ ok: false, reason: "already_active" })
    expect(core.getAttempt("i1")).toBe("att-1")
  })

  test("restores the retry queue", async () => {
    const runState = new FakeRunStatePersistence({
      retryQueue: [{ issueId: "i2", attemptCount: 1, nextRetryAt: "2026-07-16T00:05:00.000Z", lastError: "boom" }],
    })
    const { core } = buildCore(runState)

    await core.recoverFromPersistedState()

    expect(core.retryQueue.entries).toHaveLength(1)
    expect(core.retryQueue.entries[0]?.issueId).toBe("i2")
  })

  test("is idempotent — calling recoverFromPersistedState twice does not duplicate the retry queue", async () => {
    const runState = new FakeRunStatePersistence({
      retryQueue: [{ issueId: "i2", attemptCount: 1, nextRetryAt: "2026-07-16T00:05:00.000Z", lastError: "boom" }],
    })
    const { core } = buildCore(runState)

    await core.recoverFromPersistedState()
    await core.recoverFromPersistedState()

    expect(core.retryQueue.entries).toHaveLength(1)
  })

  test("is a no-op when no snapshot was persisted", async () => {
    const { core, runState } = buildCore()
    await core.recoverFromPersistedState()
    expect(runState.replaceActiveAttemptsCalls).toHaveLength(0)
    expect(runState.replaceRetryQueueCalls).toHaveLength(0)
  })
})

describe("OrchestratorCore — startup sync does not duplicate a recovered-alive attempt", () => {
  let dispatcher: {
    ipCalls: string[]
    handleIssueTodo: () => Promise<void>
    handleIssueInProgress: (issue: { id: string }) => Promise<void>
  }

  beforeEach(() => {
    dispatcher = {
      ipCalls: [],
      handleIssueTodo: async () => {},
      handleIssueInProgress: async (issue) => {
        dispatcher.ipCalls.push(issue.id)
      },
    }
  })

  test("canAcceptIssue guards a reattached issue so IssueLifecycle.tryAcceptOrQueue skips it", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true)
    const runState = new FakeRunStatePersistence({
      activeAttempts: [
        { issueId: "i1", attemptId: "att-1", workspacePath: "/ws/i1", pid: 111, startedAt: "2026-07-16T00:00:00.000Z" },
      ],
    })
    const { core, tracker } = buildCore(runState)
    core.attachLifecycle(dispatcher, async () => {})
    tracker.seedIssue(
      makeIssue({ id: "i1", identifier: "PROJ-1", status: { id: "state-ip", name: "In Progress", type: "started" } }),
    )

    // start() runs recovery before scheduling startup sync.
    await core.start()
    await core.stop()

    // The guard IssueLifecycle relies on (tryAcceptOrQueue -> canAcceptIssue)
    // now reports the issue as already active, so a real dispatcher would
    // return early instead of spawning a duplicate agent.
    expect(core.canAcceptIssue("i1")).toEqual({ ok: false, reason: "already_active" })
  })
})
