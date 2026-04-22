/**
 * WebhookRouter unit tests.
 *
 * Covers the dispatching contract extracted from Orchestrator (PR3).
 * PR4: all event fixtures use the tracker-agnostic domain union.
 *
 * Focus: signature verification gate, non-issue skip, relation routing,
 * Todo/InProgress/left-InProgress dispatch, and retry queue drive.
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 5.3 (PR3),
 *         docs/plans/v0-2-bigbang-design.md § 4.2 (PR4).
 */

import { beforeEach, describe, expect, test, vi } from "vitest"
import type { Issue } from "../domain/models"
import type { ParsedWebhookEvent } from "../domain/parsed-webhook-event"
import { OrchestratorCore } from "../orchestrator/orchestrator-core"
import { WebhookRouter } from "../orchestrator/webhook-router"
import { makeConfig, makeIssue } from "./characterization/helpers"
import { FakeIssueTracker } from "./fakes/fake-tracker"
import { FakeWebhookReceiver } from "./fakes/fake-webhook-receiver"
import { FakeWorkspaceGateway } from "./fakes/fake-workspace-gateway"

/**
 * Spy lifecycle that records dispatcher calls without touching workspace
 * or agent-runner. Lets us assert routing decisions in isolation.
 */
class SpyLifecycle {
  todoCalls: Issue[] = []
  inProgressCalls: Issue[] = []
  leftCalls: string[] = []
  reevaluateCalls = 0

  async handleIssueTodo(issue: Issue): Promise<void> {
    this.todoCalls.push(issue)
  }

  async handleIssueInProgress(issue: Issue): Promise<void> {
    this.inProgressCalls.push(issue)
  }

  async handleIssueLeftInProgress(issueId: string): Promise<void> {
    this.leftCalls.push(issueId)
  }

  async reevaluateWaitingIssues(): Promise<void> {
    this.reevaluateCalls++
  }
}

function buildRouter() {
  const tracker = new FakeIssueTracker()
  const webhook = new FakeWebhookReceiver<ParsedWebhookEvent>()
  const workspace = new FakeWorkspaceGateway()
  const config = makeConfig()
  const events: Array<{ event: string; payload: Record<string, unknown> }> = []

  const core = new OrchestratorCore({
    config,
    tracker,
    webhook,
    workspace,
    emit: (event, payload) => events.push({ event, payload }),
  })

  const lifecycle = new SpyLifecycle()
  // Router is allowed to access core.processRetryQueue; keep the core fully wired
  // so retry drains at end of handleWebhook are well-defined no-ops.
  core.attachLifecycle(
    {
      handleIssueTodo: (issue) => lifecycle.handleIssueTodo(issue),
      handleIssueInProgress: (issue) => lifecycle.handleIssueInProgress(issue),
    },
    () => lifecycle.reevaluateWaitingIssues(),
  )
  const router = new WebhookRouter(
    core,
    lifecycle as unknown as import("../orchestrator/issue-lifecycle").IssueLifecycle,
  )
  return { router, core, tracker, webhook, lifecycle, events, config }
}

describe("WebhookRouter — signature gate", () => {
  let harness: ReturnType<typeof buildRouter>

  beforeEach(() => {
    harness = buildRouter()
  })

  test("returns 403 without dispatching when signature is invalid", async () => {
    harness.webhook.signatureValid = false
    const response = await harness.router.handleWebhook("{}", "bad-sig")

    expect(response.status).toBe(403)
    expect(response.body).toContain("Invalid signature")
    expect(harness.lifecycle.todoCalls).toHaveLength(0)
    expect(harness.lifecycle.inProgressCalls).toHaveLength(0)
  })

  test("returns 200 with skipped marker when parseEvent returns null", async () => {
    harness.webhook.nextEvent = null
    const response = await harness.router.handleWebhook("{}", "ok")

    expect(response.status).toBe(200)
    expect(response.body).toContain("skipped")
    expect(harness.lifecycle.todoCalls).toHaveLength(0)
  })
})

describe("WebhookRouter — relation events", () => {
  let harness: ReturnType<typeof buildRouter>

  beforeEach(() => {
    harness = buildRouter()
  })

  test("routes relation add to DagScheduler.addRelation and skips lifecycle", async () => {
    const spy = vi.spyOn(harness.core.dagScheduler, "addRelation")
    harness.webhook.nextEvent = {
      kind: "issue.relation_changed",
      issueId: "issue-a",
      relatedIssueId: "issue-b",
      relation: "blocks",
      added: true,
    }

    const response = await harness.router.handleWebhook("{}", "ok")

    expect(response.status).toBe(200)
    expect(spy).toHaveBeenCalledWith("issue-a", "issue-b", "blocks")
    expect(harness.lifecycle.todoCalls).toHaveLength(0)
  })

  test("routes relation remove to DagScheduler.removeRelation and triggers reevaluate", async () => {
    const removeSpy = vi.spyOn(harness.core.dagScheduler, "removeRelation")
    harness.webhook.nextEvent = {
      kind: "issue.relation_changed",
      issueId: "issue-a",
      relatedIssueId: "issue-b",
      relation: "blocks",
      added: false,
    }

    await harness.router.handleWebhook("{}", "ok")

    expect(removeSpy).toHaveBeenCalledWith("issue-a", "issue-b")
    expect(harness.lifecycle.reevaluateCalls).toBe(1)
  })
})

describe("WebhookRouter — issue events dispatch", () => {
  let harness: ReturnType<typeof buildRouter>
  let issue: Issue

  beforeEach(() => {
    harness = buildRouter()
    issue = makeIssue({ id: "issue-1", identifier: "PROJ-1" })
  })

  test("transition to=todo dispatches to lifecycle.handleIssueTodo and posts ack comment", async () => {
    harness.webhook.nextEvent = {
      kind: "issue.transitioned",
      issueId: issue.id,
      from: null,
      to: "todo",
      issue,
    }

    const response = await harness.router.handleWebhook("{}", "ok")

    expect(response.status).toBe(200)
    expect(harness.lifecycle.todoCalls).toHaveLength(1)
    expect(harness.lifecycle.todoCalls[0]?.id).toBe("issue-1")
    // Ack comment fire-and-forget; allow the promise to settle.
    await new Promise((r) => setTimeout(r, 0))
    const ack = harness.tracker.calls.find(
      (c) => c.method === "addIssueComment" && String(c.args[1]).includes("Received"),
    )
    expect(ack).toBeDefined()
  })

  test("skips ack comment when the issue is already active or being processed", async () => {
    harness.core.markProcessing(issue.id)
    harness.webhook.nextEvent = {
      kind: "issue.transitioned",
      issueId: issue.id,
      from: null,
      to: "todo",
      issue,
    }

    await harness.router.handleWebhook("{}", "ok")
    await new Promise((r) => setTimeout(r, 0))

    const ack = harness.tracker.calls.find(
      (c) => c.method === "addIssueComment" && String(c.args[1]).includes("Received"),
    )
    expect(ack).toBeUndefined()
  })

  test("transition to=in_progress dispatches to lifecycle.handleIssueInProgress without ack comment", async () => {
    harness.webhook.nextEvent = {
      kind: "issue.transitioned",
      issueId: issue.id,
      from: "todo",
      to: "in_progress",
      issue,
    }

    await harness.router.handleWebhook("{}", "ok")

    expect(harness.lifecycle.inProgressCalls).toHaveLength(1)
    expect(harness.lifecycle.todoCalls).toHaveLength(0)
  })

  test("transition from=in_progress to=done dispatches to handleIssueLeftInProgress", async () => {
    harness.webhook.nextEvent = {
      kind: "issue.transitioned",
      issueId: issue.id,
      from: "in_progress",
      to: "done",
      issue,
    }

    await harness.router.handleWebhook("{}", "ok")

    expect(harness.lifecycle.leftCalls).toEqual([issue.id])
  })

  test("records lastEventAt on every accepted event", async () => {
    expect(harness.core.state.lastEventAt).toBeNull()

    harness.webhook.nextEvent = {
      kind: "issue.transitioned",
      issueId: issue.id,
      from: "todo",
      to: "in_progress",
      issue,
    }

    await harness.router.handleWebhook("{}", "ok")

    expect(harness.core.state.lastEventAt).not.toBeNull()
  })
})
