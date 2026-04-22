/**
 * Characterization test — locks current behavior before v0.2 refactor (PR2/PR3).
 * Design: docs/plans/v0-2-bigbang-design.md § 2 (M0)
 * DO NOT modify expected values to match "desired" behavior.
 * If a test fails during refactor, investigate before updating the test.
 *
 * Scope: Orchestrator — webhook routing, state transitions, startup sync,
 * concurrency guards, retry queue entry, DAG blocker gating, graceful shutdown.
 *
 * Strategy:
 *   - Mock `../../tracker/linear-client` so no real HTTP traffic is issued.
 *   - Override `WorkspaceManager.prototype.create` to avoid real git worktrees.
 *   - Register a FakeAgentSession for the "claude" agent type so `spawn`
 *     never launches a real subprocess.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { Issue } from "../../domain/models"
import { Orchestrator } from "../../orchestrator/orchestrator"
import { registerSession } from "../../sessions/session-factory"
import { LinearTrackerAdapter } from "../../tracker/adapters/linear-adapter"
import { LinearWebhookReceiver } from "../../tracker/adapters/linear-webhook-receiver"
import { FileSystemWorkspaceGateway } from "../../workspace/adapters/fs-workspace-gateway"
import { WorkspaceManager } from "../../workspace/workspace-manager"
import { FakeAgentSession, flushMicrotasks, makeConfig, makeIssue, makeWorkspace } from "./helpers"

// ── Mock the linear-client module: every call returns controlled, inspectable data.

vi.mock("../../tracker/linear-client", () => {
  return {
    fetchIssuesByState: vi.fn(async () => [] as Issue[]),
    fetchIssueLabels: vi.fn(async () => [] as string[]),
    updateIssueState: vi.fn(async () => undefined),
    addIssueComment: vi.fn(async () => undefined),
    addIssueLabel: vi.fn(async () => undefined),
  }
})

// Prevent SessionRegistry.registerBuiltins from overwriting our fake registrations.
vi.mock("../../sessions/session-factory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sessions/session-factory")>()
  return {
    ...actual,
    registerBuiltinSessions: vi.fn(async () => undefined),
  }
})

import * as linearClient from "../../tracker/linear-client"

// ── HMAC helper — mirrors webhook-handler.test.ts so payload signatures verify.

async function computeHmac(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload))
  return Buffer.from(sig).toString("hex")
}

function makeIssuePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "Issue",
    action: "update",
    data: {
      id: "issue-web-1",
      identifier: "PROJ-42",
      title: "feat: add login",
      description: "desc",
      url: "https://linear.app/proj/issue/PROJ-42",
      state: { id: "state-ip", name: "In Progress", type: "started" },
      team: { id: "team-uuid", key: "PROJ" },
    },
    updatedFrom: { stateId: "state-todo" },
    ...overrides,
  })
}

// ── Global test scaffolding ────────────────────────────────────────

let orchestrator: Orchestrator
let workspaceRoot: string
let startCalled = false

const config = makeConfig()

/** Wraps orchestrator.start and marks so afterEach waits for the dangling runStartupSync. */
async function startOrchestrator(): Promise<void> {
  startCalled = true
  await orchestrator.start()
}

beforeEach(async () => {
  // Reset call history only; preserve the default async-() => [] implementations set at module mock time.
  vi.mocked(linearClient.fetchIssuesByState).mockReset().mockResolvedValue([])
  vi.mocked(linearClient.fetchIssueLabels).mockReset().mockResolvedValue([])
  vi.mocked(linearClient.updateIssueState).mockReset().mockResolvedValue(undefined)
  vi.mocked(linearClient.addIssueComment).mockReset().mockResolvedValue(undefined)
  vi.mocked(linearClient.addIssueLabel).mockReset().mockResolvedValue(undefined)

  FakeAgentSession.resetRegistry()

  // Register a fake session under every supported agent type so nothing spawns real processes.
  registerSession("claude", () => new FakeAgentSession())
  registerSession("codex", () => new FakeAgentSession())
  registerSession("gemini", () => new FakeAgentSession())

  // Stub WorkspaceManager.create so we don't touch git. Other methods remain real;
  // they will be called only with mock workspaces during these tests.
  workspaceRoot = await mkdtemp(join(tmpdir(), "orch-char-"))
  vi.spyOn(WorkspaceManager.prototype, "create").mockImplementation(async (issue: Issue, root?: string) =>
    makeWorkspace(issue, { path: join(root ?? workspaceRoot, issue.identifier) }),
  )

  const runtimeConfig = { ...config, workspaceRoot }
  const tracker = new LinearTrackerAdapter({
    apiKey: runtimeConfig.linearApiKey,
    teamId: runtimeConfig.linearTeamId,
    teamUuid: runtimeConfig.linearTeamUuid,
  })
  const webhook = new LinearWebhookReceiver({
    secret: runtimeConfig.linearWebhookSecret,
    workflowStates: runtimeConfig.workflowStates,
  })
  const workspaceGateway = new FileSystemWorkspaceGateway(new WorkspaceManager(runtimeConfig.workspaceRoot))

  orchestrator = new Orchestrator(runtimeConfig, tracker, webhook, workspaceGateway)
  startCalled = false
})

afterEach(async () => {
  // Stop to release timers etc; it is safe even when start was never called.
  await orchestrator.stop().catch(() => {})
  // Give any in-flight `runStartupSync` microtasks a chance to drain before the next test
  // re-assigns module mocks. Without this, a dangling startupSync from a previous test can
  // reconcile the DAG (via reconcileWithLinear) during the next test, contaminating state.
  if (startCalled) await new Promise((r) => setTimeout(r, 2_200))
  vi.restoreAllMocks()
  await rm(workspaceRoot, { recursive: true, force: true })
})

// ── Webhook signature verification ─────────────────────────────────

describe("Orchestrator.handleWebhook — signature verification gate", () => {
  test("currently returns 403 without touching Linear when signature is invalid", async () => {
    const { onWebhook } = orchestrator.getHandlers()

    const response = await onWebhook("{}", "0000deadbeef")

    expect(response.status).toBe(403)
    expect(response.body).toContain("Invalid signature")
    expect(linearClient.updateIssueState).not.toHaveBeenCalled()
    expect(linearClient.addIssueComment).not.toHaveBeenCalled()
  })

  test("currently returns 200 with skipped marker when payload is a non-issue event", async () => {
    const payload = JSON.stringify({ type: "Comment", action: "create", data: {} })
    const sig = await computeHmac(payload, config.linearWebhookSecret)
    const { onWebhook } = orchestrator.getHandlers()

    const response = await onWebhook(payload, sig)

    expect(response.status).toBe(200)
    expect(response.body).toContain("skipped")
    expect(linearClient.updateIssueState).not.toHaveBeenCalled()
  })
})

// ── Webhook routing: Todo → transition + spawn ─────────────────────

describe("Orchestrator.handleWebhook — Todo event routing", () => {
  test("currently transitions Todo issue to In Progress via updateIssueState and posts ack comment", async () => {
    const payload = makeIssuePayload({
      data: {
        id: "issue-todo-1",
        identifier: "PROJ-100",
        title: "feat: todo",
        description: "",
        url: "https://linear.app/proj/issue/PROJ-100",
        state: { id: config.workflowStates.todo, name: "Todo", type: "unstarted" },
        team: { id: "team-uuid", key: "PROJ" },
      },
    })
    const sig = await computeHmac(payload, config.linearWebhookSecret)

    const response = await orchestrator.getHandlers().onWebhook(payload, sig)
    await flushMicrotasks()

    expect(response.status).toBe(200)

    // 1. Ack comment posted (fire-and-forget)
    expect(linearClient.addIssueComment).toHaveBeenCalledWith(
      config.linearApiKey,
      "issue-todo-1",
      expect.stringContaining("Received"),
    )

    // 2. Transition to In Progress
    expect(linearClient.updateIssueState).toHaveBeenCalledWith(
      config.linearApiKey,
      "issue-todo-1",
      config.workflowStates.inProgress,
    )

    // 3. Workspace created for the issue
    const create = vi.mocked(WorkspaceManager.prototype.create)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]?.[0].identifier).toBe("PROJ-100")

    // 4. Agent session started (execute is called with the rendered prompt from promptTemplate)
    expect(FakeAgentSession.instances).toHaveLength(1)
    expect(FakeAgentSession.instances[0]?.startCalls).toHaveLength(1)
    expect(FakeAgentSession.instances[0]?.executeCalls).toHaveLength(1)
    // 5. start config wiring: agent session start() receives the resolved workspace path
    expect(FakeAgentSession.instances[0]?.startCalls[0]?.workspacePath).toContain("PROJ-100")
  })

  test("currently does not spawn the agent when updateIssueState throws; queues a retry instead", async () => {
    vi.mocked(linearClient.updateIssueState).mockRejectedValueOnce(new Error("Linear 500"))

    const payload = makeIssuePayload({
      data: {
        id: "issue-todo-fail",
        identifier: "PROJ-101",
        title: "feat: todo",
        description: "",
        url: "",
        state: { id: config.workflowStates.todo, name: "Todo", type: "unstarted" },
        team: { id: "team-uuid", key: "PROJ" },
      },
    })
    const sig = await computeHmac(payload, config.linearWebhookSecret)

    const response = await orchestrator.getHandlers().onWebhook(payload, sig)
    await flushMicrotasks()

    expect(response.status).toBe(200)
    // Workspace never created because state transition failed first
    expect(WorkspaceManager.prototype.create).not.toHaveBeenCalled()
    expect(FakeAgentSession.instances).toHaveLength(0)

    // Public status exposes retryQueueSize — confirms a retry entry was scheduled.
    const status = orchestrator.getHandlers().getStatus() as { retryQueueSize: number }
    expect(status.retryQueueSize).toBeGreaterThanOrEqual(1)
  })
})

// ── Webhook routing: In Progress (direct spawn) ────────────────────

describe("Orchestrator.handleWebhook — In Progress event routing", () => {
  test("currently spawns an agent directly without calling updateIssueState", async () => {
    const payload = makeIssuePayload({
      data: {
        id: "issue-ip-1",
        identifier: "PROJ-200",
        title: "feat: ip",
        description: "",
        url: "",
        state: { id: config.workflowStates.inProgress, name: "In Progress", type: "started" },
        team: { id: "team-uuid", key: "PROJ" },
      },
      updatedFrom: { stateId: config.workflowStates.todo },
    })
    const sig = await computeHmac(payload, config.linearWebhookSecret)

    await orchestrator.getHandlers().onWebhook(payload, sig)
    await flushMicrotasks()

    expect(linearClient.updateIssueState).not.toHaveBeenCalled()
    expect(WorkspaceManager.prototype.create).toHaveBeenCalledTimes(1)
    expect(FakeAgentSession.instances).toHaveLength(1)
  })
})

// ── Webhook routing: left-in-progress kills the active agent ───────

describe("Orchestrator.handleWebhook — left-In-Progress handling", () => {
  test("currently kills the active agent and clears active workspace state when moved out of In Progress", async () => {
    // Spawn an agent first.
    const ipPayload = makeIssuePayload({
      data: {
        id: "issue-kill-1",
        identifier: "PROJ-300",
        title: "feat: kill",
        description: "",
        url: "",
        state: { id: config.workflowStates.inProgress, name: "In Progress", type: "started" },
        team: { id: "team-uuid", key: "PROJ" },
      },
      updatedFrom: { stateId: config.workflowStates.todo },
    })
    await orchestrator.getHandlers().onWebhook(ipPayload, await computeHmac(ipPayload, config.linearWebhookSecret))
    await flushMicrotasks()

    const session = FakeAgentSession.instances[0]
    expect(session).toBeDefined()

    const active = (orchestrator.getHandlers().getStatus() as { activeWorkspaces: unknown[] }).activeWorkspaces
    expect(active).toHaveLength(1)

    // Move it out of In Progress.
    const leftPayload = makeIssuePayload({
      action: "update",
      data: {
        id: "issue-kill-1",
        identifier: "PROJ-300",
        title: "feat: kill",
        description: "",
        url: "",
        state: { id: config.workflowStates.done, name: "Done", type: "completed" },
        team: { id: "team-uuid", key: "PROJ" },
      },
      updatedFrom: { stateId: config.workflowStates.inProgress },
    })
    await orchestrator.getHandlers().onWebhook(leftPayload, await computeHmac(leftPayload, config.linearWebhookSecret))
    await flushMicrotasks()

    // Cancel was called on the fake session (kill() goes through cancel path in AgentRunnerService).
    expect(session?.cancelCalls).toBeGreaterThanOrEqual(1)

    // Active workspace entry is removed.
    const after = (orchestrator.getHandlers().getStatus() as { activeWorkspaces: unknown[] }).activeWorkspaces
    expect(after).toHaveLength(0)
  })

  test("currently is a no-op when left-In-Progress arrives for an unknown issue", async () => {
    const payload = makeIssuePayload({
      data: {
        id: "issue-unknown",
        identifier: "PROJ-999",
        title: "",
        description: "",
        url: "",
        state: { id: config.workflowStates.done, name: "Done", type: "completed" },
        team: { id: "team-uuid", key: "PROJ" },
      },
      updatedFrom: { stateId: config.workflowStates.inProgress },
    })

    const response = await orchestrator
      .getHandlers()
      .onWebhook(payload, await computeHmac(payload, config.linearWebhookSecret))

    expect(response.status).toBe(200)
    expect(FakeAgentSession.instances).toHaveLength(0)
  })
})

// ── Relation webhook routing ───────────────────────────────────────

describe("Orchestrator.handleWebhook — IssueRelation events", () => {
  test("currently returns 200 for relation create without spawning an agent", async () => {
    const payload = JSON.stringify({
      type: "IssueRelation",
      action: "create",
      data: { id: "rel-1", type: "blocks", issueId: "issue-a", relatedIssueId: "issue-b" },
    })
    const sig = await computeHmac(payload, config.linearWebhookSecret)

    const response = await orchestrator.getHandlers().onWebhook(payload, sig)

    expect(response.status).toBe(200)
    expect(FakeAgentSession.instances).toHaveLength(0)
  })
})

// ── Concurrency guard ──────────────────────────────────────────────

describe("Orchestrator.handleWebhook — concurrency and duplicate-event guards", () => {
  test("currently enqueues a retry when maxParallel is reached instead of spawning a second agent", async () => {
    const slimConfig = { ...config, workspaceRoot, maxParallel: 1 }
    const slimTracker = new LinearTrackerAdapter({
      apiKey: slimConfig.linearApiKey,
      teamId: slimConfig.linearTeamId,
      teamUuid: slimConfig.linearTeamUuid,
    })
    const slimWebhook = new LinearWebhookReceiver({
      secret: slimConfig.linearWebhookSecret,
      workflowStates: slimConfig.workflowStates,
    })
    const slimWorkspace = new FileSystemWorkspaceGateway(new WorkspaceManager(slimConfig.workspaceRoot))
    const slimOrch = new Orchestrator(slimConfig, slimTracker, slimWebhook, slimWorkspace)

    const payloadA = makeIssuePayload({
      data: {
        id: "issue-a",
        identifier: "PROJ-401",
        title: "feat: a",
        description: "",
        url: "",
        state: { id: config.workflowStates.inProgress, name: "In Progress", type: "started" },
        team: { id: "team-uuid", key: "PROJ" },
      },
      updatedFrom: { stateId: config.workflowStates.todo },
    })
    const payloadB = makeIssuePayload({
      data: {
        id: "issue-b",
        identifier: "PROJ-402",
        title: "feat: b",
        description: "",
        url: "",
        state: { id: config.workflowStates.inProgress, name: "In Progress", type: "started" },
        team: { id: "team-uuid", key: "PROJ" },
      },
      updatedFrom: { stateId: config.workflowStates.todo },
    })

    await slimOrch.getHandlers().onWebhook(payloadA, await computeHmac(payloadA, config.linearWebhookSecret))
    await flushMicrotasks()
    await slimOrch.getHandlers().onWebhook(payloadB, await computeHmac(payloadB, config.linearWebhookSecret))
    await flushMicrotasks()

    expect(FakeAgentSession.instances).toHaveLength(1)
    const status = slimOrch.getHandlers().getStatus() as { retryQueueSize: number }
    expect(status.retryQueueSize).toBeGreaterThanOrEqual(1)

    await slimOrch.stop().catch(() => {})
  })

  test("currently skips the duplicate In Progress webhook for an already-active issue", async () => {
    const payload = makeIssuePayload({
      data: {
        id: "issue-dup",
        identifier: "PROJ-500",
        title: "feat: dup",
        description: "",
        url: "",
        state: { id: config.workflowStates.inProgress, name: "In Progress", type: "started" },
        team: { id: "team-uuid", key: "PROJ" },
      },
      updatedFrom: { stateId: config.workflowStates.todo },
    })

    await orchestrator.getHandlers().onWebhook(payload, await computeHmac(payload, config.linearWebhookSecret))
    await flushMicrotasks()
    await orchestrator.getHandlers().onWebhook(payload, await computeHmac(payload, config.linearWebhookSecret))
    await flushMicrotasks()

    // Only one session spawned — duplicate was short-circuited by the active-workspace guard.
    expect(FakeAgentSession.instances).toHaveLength(1)
  })
})

// ── Startup sync ───────────────────────────────────────────────────

describe("Orchestrator — startup sync behavior (observable effects only)", () => {
  test("currently fetches Todo + InProgress issues at start() via fetchIssuesByState", async () => {
    vi.mocked(linearClient.fetchIssuesByState).mockResolvedValueOnce([])

    await startOrchestrator()
    // Wait longer than the 2s boot delay in ensureStartupSync.
    await new Promise((r) => setTimeout(r, 2_200))

    expect(linearClient.fetchIssuesByState).toHaveBeenCalled()
    const call = vi.mocked(linearClient.fetchIssuesByState).mock.calls[0]
    expect(call?.[0]).toBe(config.linearApiKey)
    expect(call?.[1]).toBe(config.linearTeamUuid)
    expect(call?.[2]).toEqual([config.workflowStates.todo, config.workflowStates.inProgress])
  })

  test("currently emits node.join with config summary when start() is called", async () => {
    const events: Array<{ event: string; payload: unknown }> = []
    orchestrator.on("node.join", (payload) => events.push({ event: "node.join", payload }))

    await startOrchestrator()

    expect(events).toHaveLength(1)
    const payload = events[0]?.payload as { defaultAgentType: string; maxParallel: number; displayName: string }
    expect(payload.defaultAgentType).toBe(config.agentType)
    expect(payload.maxParallel).toBe(config.maxParallel)
  })
})

// ── Graceful shutdown ──────────────────────────────────────────────

describe("Orchestrator.stop — graceful shutdown", () => {
  test("currently emits node.leave with reason=graceful and flips isRunning to false", async () => {
    const leaveEvents: Array<{ reason: string }> = []
    orchestrator.on("node.leave", (payload) => leaveEvents.push(payload as { reason: string }))

    await startOrchestrator()
    await orchestrator.stop()

    expect(leaveEvents).toHaveLength(1)
    expect(leaveEvents[0]?.reason).toBe("graceful")

    const status = orchestrator.getHandlers().getStatus() as { isRunning: boolean }
    expect(status.isRunning).toBe(false)
  })

  test("currently kills any in-flight agent sessions during stop()", async () => {
    await startOrchestrator()

    const payload = makeIssuePayload({
      data: {
        id: "issue-stop",
        identifier: "PROJ-600",
        title: "feat: stop",
        description: "",
        url: "",
        state: { id: config.workflowStates.inProgress, name: "In Progress", type: "started" },
        team: { id: "team-uuid", key: "PROJ" },
      },
      updatedFrom: { stateId: config.workflowStates.todo },
    })
    await orchestrator.getHandlers().onWebhook(payload, await computeHmac(payload, config.linearWebhookSecret))
    await flushMicrotasks()

    const session = FakeAgentSession.instances[0]
    expect(session?.isAlive()).toBe(true)

    await orchestrator.stop()

    // killAll() is invoked in stop() and walks through cancel() on active sessions.
    expect(session?.cancelCalls).toBeGreaterThanOrEqual(1)
  })
})

// ── DAG blocker gating (observable via status.waitingIssues) ───────

describe("Orchestrator — DAG blocker gating of Todo issues (startup sync)", () => {
  test("currently keeps a blocked Todo issue in waitingIssues and posts a blocked-by comment during startup sync", async () => {
    const blocker: Issue = makeIssue({
      id: "blocker-1",
      identifier: "PROJ-700",
      status: { id: config.workflowStates.todo, name: "Todo", type: "unstarted" },
    })
    const blocked: Issue = makeIssue({
      id: "blocked-1",
      identifier: "PROJ-701",
      status: { id: config.workflowStates.todo, name: "Todo", type: "unstarted" },
      relations: [{ type: "blocked_by", relatedIssueId: "blocker-1", relatedIdentifier: "PROJ-700" }],
    })

    // Whenever the orchestrator asks for Todo+InProgress issues, hand it the two-issue set.
    // This is steady-state: even retries see the same data.
    vi.mocked(linearClient.fetchIssuesByState).mockResolvedValue([blocker, blocked])

    await startOrchestrator()
    // Boot delay is 2s; add margin for async work.
    await new Promise((r) => setTimeout(r, 2_800))

    const status = orchestrator.getHandlers().getStatus() as { waitingIssues: number }
    expect(status.waitingIssues).toBeGreaterThanOrEqual(1)

    // A blocked-by comment is posted for the blocked issue.
    const commentCalls = vi.mocked(linearClient.addIssueComment).mock.calls
    const blockedByComment = commentCalls.find((c) => c[1] === "blocked-1" && /blocked by/i.test(String(c[2])))
    expect(blockedByComment).toBeDefined()
  }, 10_000)
})

// ── Retry queue entry surfaced via status ──────────────────────────

describe("Orchestrator — retry queue entry via workspace creation failure", () => {
  test("currently schedules a retry (no agent spawn) when WorkspaceManager.create throws", async () => {
    // Override create to throw for this scenario only.
    vi.mocked(WorkspaceManager.prototype.create).mockRejectedValueOnce(new Error("disk full"))

    const payload = makeIssuePayload({
      data: {
        id: "issue-ws-fail",
        identifier: "PROJ-800",
        title: "feat: ws-fail",
        description: "",
        url: "",
        state: { id: config.workflowStates.inProgress, name: "In Progress", type: "started" },
        team: { id: "team-uuid", key: "PROJ" },
      },
      updatedFrom: { stateId: config.workflowStates.todo },
    })

    await orchestrator.getHandlers().onWebhook(payload, await computeHmac(payload, config.linearWebhookSecret))
    await flushMicrotasks()

    expect(FakeAgentSession.instances).toHaveLength(0)

    const status = orchestrator.getHandlers().getStatus() as { retryQueueSize: number }
    expect(status.retryQueueSize).toBeGreaterThanOrEqual(1)
  })
})
