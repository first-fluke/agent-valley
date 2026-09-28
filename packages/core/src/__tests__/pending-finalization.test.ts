import { describe, expect, test } from "vitest"
import type { ParsedWebhookEvent } from "../domain/parsed-webhook-event"
import { OrchestratorCore } from "../orchestrator/orchestrator-core"
import type { PersistedFinalization } from "../orchestrator/persistence/run-state-store"
import { makeConfig, makeIssue, makeWorkspace } from "./characterization/helpers"
import { FakeRunStatePersistence } from "./fakes/fake-run-state-persistence"
import { FakeIssueTracker } from "./fakes/fake-tracker"
import { FakeWebhookReceiver } from "./fakes/fake-webhook-receiver"
import { FakeWorkspaceGateway } from "./fakes/fake-workspace-gateway"

function setup(store = new FakeRunStatePersistence(), tracker = new FakeIssueTracker()) {
  const workspace = new FakeWorkspaceGateway()
  const events: string[] = []
  const issue = makeIssue({ status: { id: "state-ip", name: "In Progress", type: "started" } })
  tracker.seedIssue(issue)
  const core = new OrchestratorCore({
    config: makeConfig(),
    tracker,
    workspace,
    runStatePersistence: store,
    webhook: new FakeWebhookReceiver<ParsedWebhookEvent>(),
    emit: (name) => events.push(name),
  })
  const record: PersistedFinalization = {
    issueId: issue.id,
    issueKey: issue.identifier,
    parentId: null,
    attemptId: "attempt-1",
    agentType: "claude",
    workspace: makeWorkspace(issue),
    deliveryMode: "merge",
    hasCodeChanges: true,
    autoCommitted: false,
    durationMs: 1000,
    tokenUsage: { input: 7, output: 3, model: "test" },
  }
  return { core, tracker, workspace, store, events, record }
}

describe("pending tracker finalization", () => {
  test.each([
    "phase flush",
    "workspace cleanup",
  ])("cancellation during %s suppresses the success event and DAG transition", async (pausedStep) => {
    const { core, tracker, workspace, store, events, record } = setup()
    const issue = tracker.issues.get(record.issueId)
    if (!issue) throw new Error("seed issue missing")
    core.dagScheduler.buildFromIssues([issue])

    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered = () => {}
    const paused = new Promise<void>((resolve) => {
      entered = resolve
    })

    if (pausedStep === "phase flush") {
      const originalFlush = store.flushOrThrow.bind(store)
      let flushCalls = 0
      store.flushOrThrow = async () => {
        flushCalls++
        if (flushCalls === 2) {
          entered()
          await gate
        }
        await originalFlush()
      }
    } else {
      const originalCleanup = workspace.cleanup.bind(workspace)
      workspace.cleanup = async (target) => {
        entered()
        await gate
        await originalCleanup(target)
      }
    }

    const finalizing = core.buildCompletionDeps().finalizeDelivered(record)
    await paused
    issue.status.id = "state-cancelled"
    await core.cancelPendingFinalization(record.issueId)
    release()
    await finalizing

    expect(events).not.toContain("agent.done")
    expect(core.dagScheduler.getNode(record.issueId)?.status).toBe("cancelled")
    expect(store.current().pendingFinalizations).toEqual([])
  })

  test("an older finalization cannot delete a newer pending attempt", async () => {
    const { core, workspace, store, events, record } = setup()
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered = () => {}
    const paused = new Promise<void>((resolve) => {
      entered = resolve
    })
    const originalCleanup = workspace.cleanup.bind(workspace)
    workspace.cleanup = async (target) => {
      entered()
      await gate
      await originalCleanup(target)
    }

    const oldFinalization = core.buildCompletionDeps().finalizeDelivered(record)
    await paused
    const newer = { ...record, attemptId: "attempt-2" }
    await core.buildCompletionDeps().finalizeDelivered(newer)
    release()
    await oldFinalization

    expect(store.current().pendingFinalizations).toEqual([newer])
    expect(core.canAcceptIssue(record.issueId).ok).toBe(false)
    expect(events).not.toContain("agent.done")
  })

  test("keeps delivery pending after three failures and later emits success once", async () => {
    const { core, tracker, workspace, store, events, record } = setup()
    let stateCalls = 0
    const update = tracker.updateIssueState.bind(tracker)
    tracker.updateIssueState = async (id, state) => {
      expect(store.current().pendingFinalizations).toHaveLength(1)
      stateCalls++
      if (stateCalls <= 3) throw new Error("temporary tracker outage")
      await update(id, state)
    }
    core.addActiveWorkspace(record.issueId, record.workspace)
    core.registerAttempt(record.issueId, record.attemptId)
    await core.buildCompletionDeps().finalizeDelivered(record)
    expect(stateCalls).toBe(3)
    expect(store.current().pendingFinalizations).toHaveLength(1)
    expect(core.canAcceptIssue(record.issueId)).toEqual({ ok: false, reason: "already_active" })
    expect(events).not.toContain("agent.done")
    await core.processRetryQueue()
    expect(stateCalls).toBe(4)
    expect(store.current().pendingFinalizations).toEqual([])
    expect(events.filter((event) => event === "agent.done")).toHaveLength(1)
    expect(workspace.events.filter((event) => event.startsWith("cleanup:"))).toHaveLength(1)
    await core.processRetryQueue()
    expect(stateCalls).toBe(4)
  })

  test("does not ask tracker for Done until pending delivery is durable", async () => {
    const { core, tracker, store, record } = setup()
    const flush = store.flushOrThrow.bind(store)
    store.flushOrThrow = async () => {
      throw new Error("disk full")
    }

    await expect(core.buildCompletionDeps().finalizeDelivered(record)).rejects.toThrow("disk full")
    expect(tracker.calls.filter((call) => call.method === "updateIssueState")).toHaveLength(0)
    expect(core.canAcceptIssue(record.issueId).ok).toBe(false)

    store.flushOrThrow = flush
    await core.processRetryQueue()
    expect(tracker.calls.filter((call) => call.method === "updateIssueState")).toHaveLength(1)
  })

  test("restores a pending record after restart without rerunning delivery", async () => {
    const { core, tracker, store, record } = setup()
    tracker.updateIssueState = async () => {
      throw new Error("offline")
    }
    await core.buildCompletionDeps().finalizeDelivered(record)
    const restored = setup(store, tracker)
    await restored.core.recoverFromPersistedState()
    expect(restored.core.canAcceptIssue(record.issueId).ok).toBe(false)
    tracker.updateIssueState = async (id, state) => {
      const issue = tracker.issues.get(id)
      if (issue) issue.status.id = state
    }
    await restored.core.processRetryQueue()
    expect(restored.events.filter((event) => event === "agent.done")).toHaveLength(1)
    expect(restored.workspace.events.filter((event) => event.startsWith("mergeAndPush:"))).toHaveLength(0)
    expect(store.current().pendingFinalizations).toEqual([])
  })

  test("restores tracker-confirmed state without repeating the Done mutation", async () => {
    const first = setup()
    first.store.replacePendingFinalizations([{ ...first.record, phase: "tracker_confirmed" }])
    const restored = setup(first.store, first.tracker)
    restored.tracker.updateIssueState = async () => {
      throw new Error("must not repeat Done")
    }

    await restored.core.recoverFromPersistedState()
    await restored.core.processRetryQueue()

    expect(restored.events.filter((event) => event === "agent.done")).toHaveLength(1)
    expect(first.store.current().pendingFinalizations).toEqual([])
  })

  test("cancellation drops pending finalization and never emits Done", async () => {
    const { core, tracker, store, events, record } = setup()
    tracker.updateIssueState = async () => {
      throw new Error("offline")
    }
    await core.buildCompletionDeps().finalizeDelivered(record)
    await core.cancelPendingFinalization(record.issueId)
    await core.processRetryQueue()
    expect(store.current().pendingFinalizations).toEqual([])
    expect(events).not.toContain("agent.done")
  })

  test("observed tracker cancellation after restart suppresses Done", async () => {
    const first = setup()
    first.store.replacePendingFinalizations([first.record])
    const issue = first.tracker.issues.get(first.record.issueId)
    if (!issue) throw new Error("seed issue missing")
    issue.status.id = "state-cancelled"
    const restored = setup(first.store, first.tracker)
    // setup seeds an InProgress copy; preserve the externally cancelled state.
    const current = restored.tracker.issues.get(first.record.issueId)
    if (!current) throw new Error("seed issue missing")
    current.status.id = "state-cancelled"
    await restored.core.recoverFromPersistedState()
    await restored.core.processRetryQueue()
    expect(restored.events).not.toContain("agent.done")
    expect(first.store.current().pendingFinalizations).toEqual([])
  })
})
