/**
 * Budget integration tests — verify the Orchestrator / IssueLifecycle
 * hook wires a BudgetService and cancels spawn when the budget gate
 * denies it (design § 4.5, § 6.4 E16).
 */

import { describe, expect, test, vi } from "vitest"
import type { ParsedWebhookEvent } from "../domain/parsed-webhook-event"
import type { BudgetService } from "../orchestrator/budget-service"
import { createInMemoryBudgetService, createNoopBudgetService } from "../orchestrator/budget-service"
import { IssueLifecycle } from "../orchestrator/issue-lifecycle"
import { OrchestratorCore } from "../orchestrator/orchestrator-core"
import { registerSession } from "../sessions/session-factory"
import { FakeAgentSession, makeConfig, makeIssue } from "./characterization/helpers"
import { FakeIssueTracker } from "./fakes/fake-tracker"
import { FakeWebhookReceiver } from "./fakes/fake-webhook-receiver"
import { FakeWorkspaceGateway } from "./fakes/fake-workspace-gateway"

vi.mock("../sessions/session-factory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sessions/session-factory")>()
  return {
    ...actual,
    registerBuiltinSessions: vi.fn(async () => undefined),
  }
})

function buildLifecycleWithBudget(budget: BudgetService) {
  FakeAgentSession.resetRegistry()
  registerSession("claude", () => new FakeAgentSession())

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
    budget,
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

describe("Budget integration — spawn gate", () => {
  test("no-op budget service allows spawn (baseline)", async () => {
    const h = buildLifecycleWithBudget(createNoopBudgetService())
    const issue = makeIssue({ id: "i1", identifier: "PROJ-1" })

    await h.lifecycle.handleIssueInProgress(issue)

    expect(FakeAgentSession.instances).toHaveLength(1)
    expect(h.workspace.events).toContain("create:i1")
  })

  test("denies spawn, cancels issue, and posts a budget comment when the cap is reached", async () => {
    const budget = createInMemoryBudgetService({
      caps: {
        perIssue: { tokens: 100, usd: 1000 },
        perDay: { tokens: 10_000, usd: 1000 },
        onExceed: "block",
        allowOverrideLabel: false,
        pricing: {},
      },
    })
    // Pre-seed usage so the issue is already over the per-issue cap
    await budget.recordUsage("prev", "i-blocked", {
      input: 200,
      output: 0,
      model: "unknown",
    })

    const h = buildLifecycleWithBudget(budget)
    const issue = makeIssue({ id: "i-blocked", identifier: "PROJ-99" })

    await h.lifecycle.handleIssueInProgress(issue)

    expect(FakeAgentSession.instances).toHaveLength(0)
    expect(h.workspace.events.some((e) => e.startsWith("create:"))).toBe(false)

    const comment = h.tracker.calls.find(
      (c) => c.method === "addIssueComment" && String(c.args[1]).includes("budget cap reached"),
    )
    expect(comment).toBeDefined()

    const transition = h.tracker.calls.find((c) => c.method === "updateIssueState")
    expect(transition?.args).toEqual(["i-blocked", h.config.workflowStates.cancelled])

    const emitted = h.events.find((e) => e.event === "issue.transitioned" && e.payload.reason === "budget_cap")
    expect(emitted).toBeDefined()

    // Processing lock must be released so subsequent runs for the same
    // issue key are not blocked by in-flight state.
    expect(h.core.canAcceptIssue("i-blocked").ok).toBe(true)
  })

  test("spawn → complete with tokenUsage accumulates per-issue + per-day budget", async () => {
    const budget = createInMemoryBudgetService({
      caps: {
        perIssue: { tokens: 10_000, usd: 1000 },
        perDay: { tokens: 100_000, usd: 1000 },
        onExceed: "block",
        allowOverrideLabel: false,
        pricing: {
          "claude-sonnet-4.5": { inputPerMtok: 3, outputPerMtok: 15 },
        },
      },
    })

    const h = buildLifecycleWithBudget(budget)
    const issue = makeIssue({ id: "i-usage", identifier: "PROJ-77" })

    await h.lifecycle.handleIssueInProgress(issue)

    expect(FakeAgentSession.instances).toHaveLength(1)
    const session = FakeAgentSession.instances[0]
    if (!session) throw new Error("expected FakeAgentSession instance")

    // Drive the agent to completion with a known token usage payload.
    session.emit("complete", {
      type: "complete",
      result: {
        exitCode: 0,
        output: "all done",
        durationMs: 1234,
        filesChanged: [],
        tokenUsage: { input: 1000, output: 500, model: "claude-sonnet-4.5" },
      },
    })

    // Allow microtasks + any onComplete async work to settle
    await new Promise((r) => setTimeout(r, 20))

    // Per-issue accumulator reflects the reported usage
    const issueUsed = budget.getIssueUsed("i-usage")
    expect(issueUsed.tokens).toBe(1500)
    // cost = (1000 * 3 + 500 * 15) / 1_000_000 = 0.0105
    expect(issueUsed.usd).toBeCloseTo(0.0105, 6)

    // Per-day accumulator also incremented
    const dayUsed = budget.getDailyUsed()
    expect(dayUsed.tokens).toBe(1500)
    expect(dayUsed.usd).toBeCloseTo(0.0105, 6)
  })

  test("spawn → complete without tokenUsage leaves budget counters at zero", async () => {
    const budget = createInMemoryBudgetService({
      caps: {
        perIssue: { tokens: 10_000, usd: 1000 },
        perDay: { tokens: 100_000, usd: 1000 },
        onExceed: "block",
        allowOverrideLabel: false,
        pricing: {},
      },
    })

    const h = buildLifecycleWithBudget(budget)
    const issue = makeIssue({ id: "i-no-usage", identifier: "PROJ-78" })

    await h.lifecycle.handleIssueInProgress(issue)
    const session = FakeAgentSession.instances[0]
    if (!session) throw new Error("expected FakeAgentSession instance")

    session.emit("complete", {
      type: "complete",
      result: {
        exitCode: 0,
        output: "no usage surfaced",
        durationMs: 500,
        filesChanged: [],
        // tokenUsage omitted
      },
    })

    await new Promise((r) => setTimeout(r, 20))

    expect(budget.getIssueUsed("i-no-usage")).toEqual({ tokens: 0, usd: 0 })
    expect(budget.getDailyUsed()).toEqual({ tokens: 0, usd: 0 })
  })

  test("warn mode allows spawn even when cap is reached", async () => {
    const budget = createInMemoryBudgetService({
      caps: {
        perIssue: { tokens: 100, usd: 1000 },
        perDay: { tokens: 10_000, usd: 1000 },
        onExceed: "warn",
        allowOverrideLabel: false,
        pricing: {},
      },
    })
    await budget.recordUsage("prev", "i-warn", {
      input: 500,
      output: 0,
      model: "unknown",
    })

    const h = buildLifecycleWithBudget(budget)
    const issue = makeIssue({ id: "i-warn", identifier: "PROJ-500" })

    await h.lifecycle.handleIssueInProgress(issue)

    expect(FakeAgentSession.instances).toHaveLength(1)
    expect(h.workspace.events).toContain("create:i-warn")
    // No cancel transition posted
    const transition = h.tracker.calls.find(
      (c) => c.method === "updateIssueState" && c.args[1] === h.config.workflowStates.cancelled,
    )
    expect(transition).toBeUndefined()
  })
})
