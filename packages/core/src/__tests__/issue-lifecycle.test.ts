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

import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { Issue } from "../domain/models"
import type { ParsedWebhookEvent } from "../domain/parsed-webhook-event"
import { InterventionBus } from "../orchestrator/intervention-bus"
import { IssueLifecycle } from "../orchestrator/issue-lifecycle"
import { OrchestratorCore } from "../orchestrator/orchestrator-core"
import { WebhookRouter } from "../orchestrator/webhook-router"
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

const fixtures: Array<{ core: OrchestratorCore; workspaceRoot: string }> = []

afterEach(async () => {
  for (const { core, workspaceRoot } of fixtures.splice(0)) {
    await core.stop()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

function buildLifecycle(overrides: { config?: ReturnType<typeof makeConfig> } = {}) {
  FakeAgentSession.resetRegistry()
  registerSession("claude", () => new FakeAgentSession())

  const tracker = new FakeIssueTracker()
  const webhook = new FakeWebhookReceiver<ParsedWebhookEvent>()
  const workspace = new FakeWorkspaceGateway()
  const workspaceRoot = mkdtempSync(join(tmpdir(), "agent-valley-issue-lifecycle-"))
  const config = { ...(overrides.config ?? makeConfig()), workspaceRoot }
  const events: Array<{ event: string; payload: Record<string, unknown> }> = []

  const core = new OrchestratorCore({
    config,
    tracker,
    webhook,
    workspace,
    emit: (event, payload) => events.push({ event, payload }),
  })
  fixtures.push({ core, workspaceRoot })
  const lifecycle = new IssueLifecycle(core)
  core.attachLifecycle(
    {
      handleIssueTodo: (issue, rc) => lifecycle.handleIssueTodo(issue, rc),
      handleIssueInProgress: (issue, rc) => lifecycle.handleIssueInProgress(issue, rc),
    },
    () => lifecycle.reevaluateWaitingIssues(),
  )

  return { core, lifecycle, tracker, workspace, webhook, events, config }
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

    await Promise.all([h.lifecycle.handleIssueTodo(a), h.lifecycle.handleIssueTodo(b)])

    expect(FakeAgentSession.instances).toHaveLength(1)
    const status = h.core.getStatus() as { retryQueueSize: number }
    expect(status.retryQueueSize).toBeGreaterThanOrEqual(1)
  })
})

describe("IssueLifecycle.handleIssueInProgress", () => {
  test("workspace preparation failures consume the retry budget and eventually cancel", async () => {
    const h = buildLifecycle({ config: makeConfig({ agentMaxRetries: 2 }) })
    h.workspace.create = vi.fn(async () => {
      throw new Error("disk full")
    })
    const issue = makeIssue({ id: "ws-fail", identifier: "PROJ-50" })
    await h.lifecycle.handleIssueInProgress(issue)
    expect(h.core.retryQueue.entries[0]?.attemptCount).toBe(1)
    h.core.removeRetry(issue.id)
    await h.lifecycle.handleIssueInProgress(issue, { attemptCount: 1, lastError: "disk full" })
    expect(h.core.retryQueue.size).toBe(0)
    expect(h.tracker.calls).toContainEqual({
      method: "updateIssueState",
      args: [issue.id, h.config.workflowStates.cancelled],
    })
    expect(h.core.processingIssues.has(issue.id)).toBe(false)
  })

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
  test.each(["abort", "append_prompt"] as const)(
    "operator %s releases the old attempt and preserves the requested outcome",
    async (kind) => {
      const h = buildLifecycle()
      const bus = new InterventionBus({
        runner: h.core.agentRunner,
        port: h.core.agentRunnerPort,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      })
      h.core.attachIntervention(bus)
      const issue = makeIssue({ id: "intervened", identifier: "PROJ-60" })
      await h.lifecycle.handleIssueInProgress(issue)
      const attempt = h.core.getAttempt(issue.id)
      expect(attempt).toBeDefined()
      if (!attempt) return
      const result = await bus.send(
        attempt,
        kind === "abort" ? { kind, reason: "operator stopped" } : { kind, text: "include regression tests" },
      )
      expect(result.ok).toBe(true)
      expect(h.core.getActiveWorkspace(issue.id)).toBeUndefined()
      expect(h.core.getAttempt(issue.id)).toBeUndefined()
      expect(h.core.agentRunner.activeCount).toBe(0)
      if (kind === "abort") {
        expect(h.core.retryQueue.size).toBe(0)
        expect(h.tracker.calls).toContainEqual({
          method: "updateIssueState",
          args: [issue.id, h.config.workflowStates.cancelled],
        })
      } else {
        expect(h.core.retryQueue.entries[0]?.lastError).toContain("include regression tests")
      }
    },
  )

  test("cancellation during workspace creation prevents a late spawn", async () => {
    const h = buildLifecycle()
    const originalCreate = h.workspace.create.bind(h.workspace)
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered: (() => void) | undefined
    const creating = new Promise<void>((resolve) => {
      entered = resolve
    })
    h.workspace.create = async (issue, root) => {
      entered?.()
      await gate
      return originalCreate(issue, root)
    }
    const issue = makeIssue({ id: "cancel-before-spawn", identifier: "PROJ-60" })
    const preparation = h.lifecycle.handleIssueInProgress(issue)
    await creating
    await h.lifecycle.handleIssueLeftInProgress(issue.id)
    release?.()
    await preparation
    expect(FakeAgentSession.instances).toHaveLength(0)
    expect(h.core.getActiveWorkspace(issue.id)).toBeUndefined()
  })

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
  test("a free slot immediately takes a task queued only for capacity", async () => {
    const h = buildLifecycle({ config: makeConfig({ maxParallel: 1 }) })
    const running = makeIssue({ id: "running", identifier: "PROJ-1" })
    const queued = makeIssue({ id: "queued", identifier: "PROJ-2" })
    h.tracker.seedIssue(queued)
    await h.lifecycle.handleIssueInProgress(running)
    await h.lifecycle.handleIssueTodo(queued)
    expect(h.core.retryQueue.size).toBe(1)
    await h.lifecycle.handleIssueLeftInProgress(running.id)
    await h.core.fillVacantSlots()
    expect(h.core.retryQueue.size).toBe(0)
    expect(h.core.getActiveWorkspace(queued.id)).toBeDefined()
  })

  test("a new webhook task waits for its blocker and starts after an operator marks the blocker Done", async () => {
    const h = buildLifecycle({ config: makeConfig({ maxParallel: 1 }) })
    const router = new WebhookRouter(h.core, h.lifecycle)
    const blocker = makeIssue({ id: "blocker", identifier: "PROJ-1" })
    const task = makeIssue({
      id: "task",
      identifier: "PROJ-2",
      relations: [{ type: "blocked_by", relatedIssueId: blocker.id, relatedIdentifier: blocker.identifier }],
    })
    h.core.dagScheduler.buildFromIssues([blocker])
    h.tracker.seedIssue(task)
    const refresh = vi.fn(async () => task)
    Object.assign(h.tracker, { fetchIssue: refresh })
    h.webhook.nextEvent = {
      kind: "issue.transitioned",
      issueId: task.id,
      from: null,
      to: "todo",
      issue: { ...task, relations: [] },
    }
    await router.handleWebhook("{}", "valid")
    expect(refresh).toHaveBeenCalledWith(task.id)
    expect(FakeAgentSession.instances).toHaveLength(0)
    expect(h.core.hasWaitingIssue(task.id)).toBe(true)
    h.webhook.nextEvent = { kind: "issue.transitioned", issueId: blocker.id, from: "todo", to: "done", issue: blocker }
    await router.handleWebhook("{}", "valid")
    expect(h.core.dagScheduler.getNode(blocker.id)?.status).toBe("done")
    expect(h.core.hasWaitingIssue(task.id)).toBe(false)
    expect(h.workspace.events).toContain("create:task")
    expect(FakeAgentSession.instances).toHaveLength(1)
  })

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

    await h.core.buildCompletionDeps().triggerUnblocked([blocked.id])
    await new Promise((r) => setTimeout(r, 0))

    expect(h.core.hasWaitingIssue("w1")).toBe(false)
    expect(h.workspace.events).toContain("create:w1")
    expect(FakeAgentSession.instances).toHaveLength(1)
  })

  test("retains waiting issues if the tracker refresh fails", async () => {
    const h = buildLifecycle()
    h.core.addWaitingIssue("w1", { issueId: "w1", identifier: "PROJ-71", blockedBy: [], enqueuedAt: "t" })
    h.tracker.throwOn.set("fetchIssuesByState", new Error("tracker unavailable"))
    await h.lifecycle.reevaluateWaitingIssues()
    expect(h.core.hasWaitingIssue("w1")).toBe(true)
  })

  test("fills a slot even when the first Todo issue is blocked", async () => {
    const h = buildLifecycle({ config: makeConfig({ maxParallel: 1 }) })
    const blocker = makeIssue({ id: "blocker", identifier: "PROJ-3" })
    const blocked = makeIssue({
      id: "blocked",
      identifier: "PROJ-1",
      relations: [{ type: "blocked_by", relatedIssueId: blocker.id, relatedIdentifier: blocker.identifier }],
    })
    const ready = makeIssue({ id: "ready", identifier: "PROJ-2" })
    h.core.dagScheduler.buildFromIssues([blocker, blocked, ready])
    h.tracker.seedIssue(blocked)
    h.tracker.seedIssue(ready)
    await h.core.fillVacantSlots()
    expect(h.core.hasWaitingIssue(blocked.id)).toBe(true)
    expect(h.workspace.events).toContain("create:ready")
  })

  test("is a no-op when nothing is waiting", async () => {
    const h = buildLifecycle()
    await expect(h.lifecycle.reevaluateWaitingIssues()).resolves.toBeUndefined()
  })
})
