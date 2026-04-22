/**
 * IssueLifecycle unit tests.
 *
 * Covers the state-transition side of the orchestrator split (PR3):
 *   - Todo → updateIssueState + workspace create + agent spawn
 *   - Todo with DAG blockers → waiting + comment (no dispatch)
 *   - Todo + updateIssueState failure → retry queued, no workspace created
 *   - Workspace creation failure → retry queued, no agent spawned
 *   - InProgress path (no updateIssueState call)
 *   - left-InProgress kills agent and clears state
 *   - reevaluateWaitingIssues dispatches unblocked issues
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 5.3 (PR3).
 */

import { beforeEach, describe, expect, test, vi } from "vitest"
import type { Issue } from "../domain/models"
import type { ParsedWebhookEvent } from "../domain/parsed-webhook-event"
import { IssueLifecycle } from "../orchestrator/issue-lifecycle"
import { OrchestratorCore } from "../orchestrator/orchestrator-core"
import { registerSession } from "../sessions/session-factory"
import { FakeAgentSession, makeConfig, makeIssue } from "./characterization/helpers"
import { FakeIssueTracker } from "./fakes/fake-tracker"
import { FakeWebhookReceiver } from "./fakes/fake-webhook-receiver"
import { FakeWorkspaceGateway } from "./fakes/fake-workspace-gateway"

// Block SessionRegistry.registerBuiltins from clobbering our fake registrations.
vi.mock("../sessions/session-factory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sessions/session-factory")>()
  return {
    ...actual,
    registerBuiltinSessions: vi.fn(async () => undefined),
  }
})

function buildLifecycle(overrides: { config?: ReturnType<typeof makeConfig> } = {}) {
  FakeAgentSession.resetRegistry()
  registerSession("claude", () => new FakeAgentSession())

  const tracker = new FakeIssueTracker()
  const webhook = new FakeWebhookReceiver<ParsedWebhookEvent>()
  const workspace = new FakeWorkspaceGateway()
  const config = overrides.config ?? makeConfig()
  const events: Array<{ event: string; payload: Record<string, unknown> }> = []

  const core = new OrchestratorCore({
    config,
    tracker,
    webhook,
    workspace,
    emit: (event, payload) => events.push({ event, payload }),
  })
  const lifecycle = new IssueLifecycle(core)
  core.attachLifecycle(
    {
      handleIssueTodo: (issue, rc) => lifecycle.handleIssueTodo(issue, rc),
      handleIssueInProgress: (issue, rc) => lifecycle.handleIssueInProgress(issue, rc),
    },
    () => lifecycle.reevaluateWaitingIssues(),
  )

  return { core, lifecycle, tracker, workspace, events, config }
}

describe("IssueLifecycle.handleIssueTodo", () => {
  test("transitions Todo to In Progress then creates workspace and spawns agent", async () => {
    const h = buildLifecycle()
    const issue = makeIssue({ id: "t1", identifier: "PROJ-10" })

    await h.lifecycle.handleIssueTodo(issue)
    await new Promise((r) => setTimeout(r, 0))

    const transitioned = h.tracker.calls.find((c) => c.method === "updateIssueState")
    expect(transitioned?.args).toEqual(["t1", h.config.workflowStates.inProgress])
    expect(h.workspace.events).toContain("create:t1")
    expect(FakeAgentSession.instances).toHaveLength(1)
    expect(h.core.getActiveWorkspace("t1")).toBeDefined()
    expect(h.core.getAttempt("t1")).toBeDefined()
  })

  test("records issue in waitingIssues with blocked-by comment when DAG blockers exist", async () => {
    const h = buildLifecycle()
    const blocker = makeIssue({ id: "b1", identifier: "PROJ-20" })
    const blocked = makeIssue({
      id: "t1",
      identifier: "PROJ-21",
      relations: [{ type: "blocked_by", relatedIssueId: "b1", relatedIdentifier: "PROJ-20" }],
    })
    h.core.dagScheduler.buildFromIssues([blocker, blocked])

    await h.lifecycle.handleIssueTodo(blocked)
    await new Promise((r) => setTimeout(r, 0))

    expect(h.core.hasWaitingIssue("t1")).toBe(true)
    expect(h.tracker.calls.some((c) => c.method === "updateIssueState")).toBe(false)
    expect(FakeAgentSession.instances).toHaveLength(0)
    const comment = h.tracker.calls.find(
      (c) => c.method === "addIssueComment" && String(c.args[1]).includes("blocked by"),
    )
    expect(comment).toBeDefined()
  })

  test("queues a retry and does not create a workspace when updateIssueState throws", async () => {
    const h = buildLifecycle()
    const issue = makeIssue({ id: "t-fail", identifier: "PROJ-30" })
    h.tracker.throwOn.set("updateIssueState", new Error("Linear 500"))

    await h.lifecycle.handleIssueTodo(issue)

    expect(h.workspace.workspaces.has("t-fail")).toBe(false)
    expect(FakeAgentSession.instances).toHaveLength(0)
    const status = h.core.getStatus() as { retryQueueSize: number }
    expect(status.retryQueueSize).toBeGreaterThanOrEqual(1)
    // processing lock must be released on failure
    expect(h.core.canAcceptIssue("t-fail").ok).toBe(true)
  })

  test("does not exceed maxParallel — second concurrent Todo enqueues retry", async () => {
    const h = buildLifecycle({ config: makeConfig({ maxParallel: 1 }) })
    const a = makeIssue({ id: "a", identifier: "PROJ-101" })
    const b = makeIssue({ id: "b", identifier: "PROJ-102" })

    await h.lifecycle.handleIssueTodo(a)
    await h.lifecycle.handleIssueTodo(b)

    expect(FakeAgentSession.instances).toHaveLength(1)
    const status = h.core.getStatus() as { retryQueueSize: number }
    expect(status.retryQueueSize).toBeGreaterThanOrEqual(1)
  })
})

describe("IssueLifecycle.handleIssueInProgress", () => {
  test("spawns agent directly without updateIssueState", async () => {
    const h = buildLifecycle()
    const issue = makeIssue({
      id: "ip1",
      identifier: "PROJ-40",
      status: { id: "state-ip", name: "In Progress", type: "started" },
    })

    await h.lifecycle.handleIssueInProgress(issue)

    expect(h.tracker.calls.find((c) => c.method === "updateIssueState")).toBeUndefined()
    expect(h.workspace.events).toContain("create:ip1")
    expect(FakeAgentSession.instances).toHaveLength(1)
  })

  test("queues a retry when WorkspaceGateway.create rejects", async () => {
    const h = buildLifecycle()
    h.workspace.create = vi.fn(async () => {
      throw new Error("disk full")
    }) as typeof h.workspace.create
    const issue = makeIssue({ id: "ws-fail", identifier: "PROJ-50" })

    await h.lifecycle.handleIssueInProgress(issue)

    expect(FakeAgentSession.instances).toHaveLength(0)
    const status = h.core.getStatus() as { retryQueueSize: number }
    expect(status.retryQueueSize).toBeGreaterThanOrEqual(1)
  })
})

describe("IssueLifecycle.handleIssueLeftInProgress", () => {
  test("kills active agent, removes workspace, and marks DAG node cancelled", async () => {
    const h = buildLifecycle()
    const issue = makeIssue({ id: "live1", identifier: "PROJ-60" })
    await h.lifecycle.handleIssueInProgress(issue)
    expect(h.core.getActiveWorkspace("live1")).toBeDefined()
    const session = FakeAgentSession.instances[0]!

    h.core.dagScheduler.buildFromIssues([issue])

    await h.lifecycle.handleIssueLeftInProgress("live1")

    expect(session.cancelCalls).toBeGreaterThanOrEqual(1)
    expect(h.core.getActiveWorkspace("live1")).toBeUndefined()
    expect(h.core.getAttempt("live1")).toBeUndefined()
    expect(h.core.dagScheduler.getNode("live1")?.status).toBe("cancelled")
  })

  test("is a no-op when no active workspace exists for issue", async () => {
    const h = buildLifecycle()
    await h.lifecycle.handleIssueLeftInProgress("unknown")
    expect(FakeAgentSession.instances).toHaveLength(0)
  })
})

describe("IssueLifecycle.reevaluateWaitingIssues", () => {
  test("dispatches waiting issue once its blockers are resolved", async () => {
    const h = buildLifecycle()
    const blocker = makeIssue({ id: "b1", identifier: "PROJ-70" })
    const blocked: Issue = makeIssue({
      id: "w1",
      identifier: "PROJ-71",
      relations: [{ type: "blocked_by", relatedIssueId: "b1", relatedIdentifier: "PROJ-70" }],
    })
    h.core.dagScheduler.buildFromIssues([blocker, blocked])
    // Seed the tracker so fetchIssuesByState returns the unblocked issue
    h.tracker.seedIssue(blocked)

    // First pass: expected to park the issue into waitingIssues
    await h.lifecycle.handleIssueTodo(blocked)
    expect(h.core.hasWaitingIssue("w1")).toBe(true)

    // Resolve the blocker: mark blocker done in DAG and remove the edge
    h.core.dagScheduler.updateNodeStatus("b1", "done")
    h.core.dagScheduler.removeRelation("w1", "b1")

    await h.lifecycle.reevaluateWaitingIssues()
    await new Promise((r) => setTimeout(r, 0))

    expect(h.core.hasWaitingIssue("w1")).toBe(false)
  })

  test("is a no-op when nothing is waiting", async () => {
    const h = buildLifecycle()
    await expect(h.lifecycle.reevaluateWaitingIssues()).resolves.toBeUndefined()
  })
})
