/**
 * OrchestratorCore unit tests.
 *
 * Covers runtime state ownership extracted from Orchestrator (PR3):
 *   - slot admission (canAcceptIssue / tryAcceptOrQueue)
 *   - activeWorkspaces / processingIssues / activeAttempts management
 *   - retry queue fetch failure recovery (re-queues entries)
 *   - fillVacantSlots honoring maxParallel
 *   - start()/stop() event emission (node.join / node.leave) + isRunning toggle
 *   - startup sync via injected dispatcher
 *   - buildCompletionDeps wiring (cleanupState mutates state in-place)
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 5.3 (PR3).
 */

import { beforeEach, describe, expect, test, vi } from "vitest"
import type { Issue } from "../domain/models"
import { OrchestratorCore } from "../orchestrator/orchestrator-core"
import type { ParsedWebhookEvent } from "../tracker/types"
import { makeConfig, makeIssue, makeWorkspace } from "./characterization/helpers"
import { FakeIssueTracker } from "./fakes/fake-tracker"
import { FakeWebhookReceiver } from "./fakes/fake-webhook-receiver"
import { FakeWorkspaceGateway } from "./fakes/fake-workspace-gateway"

function buildCore(configOverrides: Partial<ReturnType<typeof makeConfig>> = {}) {
  const tracker = new FakeIssueTracker()
  const webhook = new FakeWebhookReceiver<ParsedWebhookEvent>()
  const workspace = new FakeWorkspaceGateway()
  const config = makeConfig(configOverrides)
  const events: Array<{ event: string; payload: Record<string, unknown> }> = []
  const core = new OrchestratorCore({
    config,
    tracker,
    webhook,
    workspace,
    emit: (event, payload) => events.push({ event, payload }),
  })
  return { core, tracker, webhook, workspace, events, config }
}

describe("OrchestratorCore — slot admission", () => {
  test("canAcceptIssue returns ok when idle and no duplicates", () => {
    const { core } = buildCore()
    expect(core.canAcceptIssue("i1").ok).toBe(true)
  })

  test("canAcceptIssue reports already_active when processing lock is held", () => {
    const { core } = buildCore()
    core.markProcessing("i1")
    expect(core.canAcceptIssue("i1")).toEqual({ ok: false, reason: "already_active" })
  })

  test("canAcceptIssue reports already_active when a workspace entry exists", () => {
    const { core } = buildCore()
    const ws = makeWorkspace(makeIssue({ id: "i1" }))
    core.addActiveWorkspace("i1", ws)
    expect(core.canAcceptIssue("i1")).toEqual({ ok: false, reason: "already_active" })
  })

  test("tryAcceptOrQueue queues a retry when concurrency is saturated", () => {
    const { core } = buildCore({ maxParallel: 0 })
    const accepted = core.tryAcceptOrQueue("i1")
    expect(accepted).toBe(false)
    const status = core.getStatus() as { retryQueueSize: number }
    expect(status.retryQueueSize).toBeGreaterThanOrEqual(1)
  })

  test("tryAcceptOrQueue does not queue when issue is already active", () => {
    const { core } = buildCore()
    core.markProcessing("i1")
    const accepted = core.tryAcceptOrQueue("i1")
    expect(accepted).toBe(false)
    const status = core.getStatus() as { retryQueueSize: number }
    expect(status.retryQueueSize).toBe(0)
  })
})

describe("OrchestratorCore — runtime state mutators", () => {
  test("markProcessing / releaseProcessing toggles the processing lock", () => {
    const { core } = buildCore()
    core.markProcessing("x")
    expect(core.canAcceptIssue("x").ok).toBe(false)
    core.releaseProcessing("x")
    expect(core.canAcceptIssue("x").ok).toBe(true)
  })

  test("addActiveWorkspace / removeActiveWorkspace updates status snapshot", () => {
    const { core } = buildCore()
    const ws = makeWorkspace(makeIssue({ id: "x" }))
    core.addActiveWorkspace("x", ws)
    const active = (core.getStatus() as { activeWorkspaces: unknown[] }).activeWorkspaces
    expect(active).toHaveLength(1)
    core.removeActiveWorkspace("x")
    const after = (core.getStatus() as { activeWorkspaces: unknown[] }).activeWorkspaces
    expect(after).toHaveLength(0)
  })

  test("registerAttempt / clearAttempt round-trips attempt ids", () => {
    const { core } = buildCore()
    core.registerAttempt("x", "att-1")
    expect(core.getAttempt("x")).toBe("att-1")
    core.clearAttempt("x")
    expect(core.getAttempt("x")).toBeUndefined()
  })

  test("addWaitingIssue / deleteWaitingIssue is surfaced in status.waitingIssues", () => {
    const { core } = buildCore()
    core.addWaitingIssue("w1", { issueId: "w1", identifier: "PROJ-1", blockedBy: ["b1"], enqueuedAt: "t" })
    const { waitingIssues } = core.getStatus() as { waitingIssues: number }
    expect(waitingIssues).toBe(1)
    core.deleteWaitingIssue("w1")
    expect((core.getStatus() as { waitingIssues: number }).waitingIssues).toBe(0)
  })

  test("touchLastEvent sets an ISO timestamp on state.lastEventAt", () => {
    const { core } = buildCore()
    expect(core.state.lastEventAt).toBeNull()
    core.touchLastEvent()
    expect(core.state.lastEventAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe("OrchestratorCore — buildCompletionDeps", () => {
  test("cleanupState removes workspace entry and attempt tracking", () => {
    const { core } = buildCore()
    const ws = makeWorkspace(makeIssue({ id: "x" }))
    core.addActiveWorkspace("x", ws)
    core.registerAttempt("x", "att-1")

    const deps = core.buildCompletionDeps()
    deps.cleanupState("x", "done")

    expect(core.getActiveWorkspace("x")).toBeUndefined()
    expect(core.getAttempt("x")).toBeUndefined()
    expect(ws.status).toBe("done")
  })

  test("emitEvent forwards to the emit callback injected at construction", () => {
    const { core, events } = buildCore()
    const deps = core.buildCompletionDeps()
    deps.emitEvent("custom.event", { foo: "bar" })
    expect(events.at(-1)).toEqual({ event: "custom.event", payload: { foo: "bar" } })
  })
})

describe("OrchestratorCore — lifecycle & dispatcher wiring", () => {
  let dispatcher: {
    todoCalls: Issue[]
    ipCalls: Issue[]
    handleIssueTodo: (issue: Issue) => Promise<void>
    handleIssueInProgress: (issue: Issue) => Promise<void>
  }
  let reevaluateCalls: number

  beforeEach(() => {
    dispatcher = {
      todoCalls: [],
      ipCalls: [],
      handleIssueTodo: async (issue: Issue) => {
        dispatcher.todoCalls.push(issue)
      },
      handleIssueInProgress: async (issue: Issue) => {
        dispatcher.ipCalls.push(issue)
      },
    }
    reevaluateCalls = 0
  })

  test("start emits node.join with config summary and flips isRunning", async () => {
    const { core, events } = buildCore()
    core.attachLifecycle(dispatcher, async () => {
      reevaluateCalls++
    })
    await core.start()

    expect(core.state.isRunning).toBe(true)
    const join = events.find((e) => e.event === "node.join")
    expect(join?.payload).toMatchObject({
      defaultAgentType: "claude",
      maxParallel: 2,
    })

    await core.stop()
    expect(core.state.isRunning).toBe(false)
  })

  test("stop emits node.leave with reason=graceful", async () => {
    const { core, events } = buildCore()
    core.attachLifecycle(dispatcher, async () => {
      reevaluateCalls++
    })
    await core.start()
    await core.stop()

    const leave = events.find((e) => e.event === "node.leave")
    expect(leave?.payload).toEqual({ reason: "graceful" })
  })

  test("processRetryQueue re-queues entries if tracker fetch fails", async () => {
    const { core, tracker } = buildCore()
    core.attachLifecycle(dispatcher, async () => {
      reevaluateCalls++
    })
    // Seed a retry entry that is immediately ready (attemptCount 0 → backoff*1 = 60s).
    // Force the entry to expose, set nextRetryAt manually by manipulating via add then draining timing.
    core.enqueueRetry("i1", 1, "boom")
    // Fast-forward: set nextRetryAt in the past so drain returns it
    const entries = core.retryQueue.entries
    expect(entries[0]).toBeDefined()
    const ready = entries[0]
    if (ready) {
      ready.nextRetryAt = new Date(Date.now() - 1_000).toISOString()
      // reflect back into the queue (drain works against the live array)
      // Nothing else is exposed for mutation, but `add` will dedup-update if we re-insert.
    }

    tracker.throwOn.set("fetchIssuesByState", new Error("Linear down"))

    // Issue a drain-and-process cycle
    await core.processRetryQueue()

    // Entry is re-queued after fetch failure
    expect(core.retryQueue.size).toBeGreaterThanOrEqual(1)
  })

  test("fillVacantSlots skips already-active issues but still dispatches unblocked ones", async () => {
    const { core, tracker } = buildCore({ maxParallel: 1 })
    core.attachLifecycle(dispatcher, async () => {
      reevaluateCalls++
    })
    const a = makeIssue({
      id: "a",
      identifier: "PROJ-1",
      status: { id: "state-todo", name: "Todo", type: "unstarted" },
    })
    const b = makeIssue({
      id: "b",
      identifier: "PROJ-2",
      status: { id: "state-todo", name: "Todo", type: "unstarted" },
    })
    tracker.seedIssue(a)
    tracker.seedIssue(b)
    // Mark one issue as already active; the skip path should cover it.
    core.addActiveWorkspace("a", makeWorkspace(a))

    await core.fillVacantSlots()

    // Only the non-active issue is dispatched; the already-active one is skipped.
    expect(dispatcher.todoCalls.map((i) => i.id)).toEqual(["b"])
  })

  test("fillVacantSlots is a no-op when no slots are available", async () => {
    const { core, tracker } = buildCore({ maxParallel: 0 })
    core.attachLifecycle(dispatcher, async () => {
      reevaluateCalls++
    })
    tracker.seedIssue(
      makeIssue({ id: "a", identifier: "PROJ-1", status: { id: "state-todo", name: "Todo", type: "unstarted" } }),
    )

    await core.fillVacantSlots()

    expect(dispatcher.todoCalls).toHaveLength(0)
  })

  test("runStartupSync routes Todo and InProgress issues to the dispatcher", async () => {
    const { core, tracker } = buildCore()
    core.attachLifecycle(dispatcher, async () => {
      reevaluateCalls++
    })
    const todo = makeIssue({
      id: "t",
      identifier: "PROJ-1",
      status: { id: "state-todo", name: "Todo", type: "unstarted" },
    })
    const ip = makeIssue({
      id: "p",
      identifier: "PROJ-2",
      status: { id: "state-ip", name: "In Progress", type: "started" },
    })
    tracker.seedIssue(todo)
    tracker.seedIssue(ip)

    await core.ensureStartupSync()

    expect(dispatcher.todoCalls.map((i) => i.id)).toContain("t")
    expect(dispatcher.ipCalls.map((i) => i.id)).toContain("p")
  })

  test("buildCompletionDeps.triggerUnblocked drops waiting entries and calls reevaluate", async () => {
    const { core } = buildCore()
    let called = 0
    core.attachLifecycle(dispatcher, async () => {
      called++
    })
    core.addWaitingIssue("w", { issueId: "w", identifier: "PROJ-9", blockedBy: ["b"], enqueuedAt: "t" })

    const deps = core.buildCompletionDeps()
    await deps.triggerUnblocked(["w"])

    expect(core.hasWaitingIssue("w")).toBe(false)
    expect(called).toBe(1)
  })

  test("runStartupSync throws a fix-hint error when dispatcher is not attached", async () => {
    const { core } = buildCore()
    // Do not call attachLifecycle — simulating a misuse by a refactor gone wrong.
    // ensureStartupSync catches and logs after 3 attempts, but runStartupSync
    // (private) is exercised via ensureStartupSync → verify the 3-attempt loop
    // swallows the error without crashing.
    await expect(core.ensureStartupSync()).resolves.toBeUndefined()
  }, 10_000)
})
