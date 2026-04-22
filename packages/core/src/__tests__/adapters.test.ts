/**
 * Adapter smoke tests — verify that each adapter delegates to its
 * underlying module functions / manager with the right argument shape.
 *
 * Linear HTTP is mocked at the module level (same path the real adapter
 * calls), so no real network traffic is issued.
 */
import { describe, expect, test, vi } from "vitest"

// ── LinearTrackerAdapter ───────────────────────────────────────────

vi.mock("../tracker/linear-client", () => ({
  fetchIssuesByState: vi.fn(async () => []),
  fetchIssueLabels: vi.fn(async () => ["bug"]),
  updateIssueState: vi.fn(async () => undefined),
  addIssueComment: vi.fn(async () => undefined),
  addIssueLabel: vi.fn(async () => undefined),
}))

vi.mock("../tracker/webhook-handler", () => ({
  verifyWebhookSignature: vi.fn(async (_p: string, s: string) => s === "good-sig"),
  // Return a minimal Linear-shaped issue event so the adapter exercises its
  // state-translation path. With no workflowStates configured on the
  // receiver, the mapping falls through to `issue.updated`.
  parseWebhookEvent: vi.fn((p: string) =>
    p === "unknown"
      ? null
      : {
          action: "update",
          issueId: "issue-1",
          issue: { id: "issue-1", identifier: "PROJ-1" },
          stateId: "state-ip",
          prevStateId: "state-todo",
        },
  ),
}))

import { LinearTrackerAdapter } from "../tracker/adapters/linear-adapter"
import { LinearWebhookReceiver } from "../tracker/adapters/linear-webhook-receiver"
import * as linearClient from "../tracker/linear-client"
import * as webhookHandler from "../tracker/webhook-handler"
import { FileSystemWorkspaceGateway } from "../workspace/adapters/fs-workspace-gateway"
import type { WorkspaceManager } from "../workspace/workspace-manager"

describe("LinearTrackerAdapter", () => {
  test("throws with an actionable message when apiKey is missing", () => {
    expect(() => new LinearTrackerAdapter({ apiKey: "", teamId: "PROJ", teamUuid: "u" })).toThrow(/apiKey is required/)
  })

  test("throws with an actionable message when teamId is missing", () => {
    expect(() => new LinearTrackerAdapter({ apiKey: "k", teamId: "", teamUuid: "u" })).toThrow(/teamId is required/)
  })

  test("throws with an actionable message when teamUuid is missing", () => {
    expect(() => new LinearTrackerAdapter({ apiKey: "k", teamId: "PROJ", teamUuid: "" })).toThrow(
      /teamUuid is required/,
    )
  })

  test("delegates fetchIssuesByState with teamUuid + state ids", async () => {
    const adapter = new LinearTrackerAdapter({ apiKey: "k", teamId: "PROJ", teamUuid: "u" })
    await adapter.fetchIssuesByState(["s1", "s2"])
    expect(linearClient.fetchIssuesByState).toHaveBeenCalledWith("k", "u", ["s1", "s2"])
  })

  test("delegates fetchIssueLabels", async () => {
    const adapter = new LinearTrackerAdapter({ apiKey: "k", teamId: "PROJ", teamUuid: "u" })
    const out = await adapter.fetchIssueLabels("issue-1")
    expect(out).toEqual(["bug"])
    expect(linearClient.fetchIssueLabels).toHaveBeenCalledWith("k", "issue-1")
  })

  test("delegates updateIssueState", async () => {
    const adapter = new LinearTrackerAdapter({ apiKey: "k", teamId: "PROJ", teamUuid: "u" })
    await adapter.updateIssueState("issue-1", "state-done")
    expect(linearClient.updateIssueState).toHaveBeenCalledWith("k", "issue-1", "state-done")
  })

  test("delegates addIssueComment", async () => {
    const adapter = new LinearTrackerAdapter({ apiKey: "k", teamId: "PROJ", teamUuid: "u" })
    await adapter.addIssueComment("issue-1", "hi")
    expect(linearClient.addIssueComment).toHaveBeenCalledWith("k", "issue-1", "hi")
  })

  test("delegates addIssueLabel with teamId (not teamUuid) for label mutations", async () => {
    const adapter = new LinearTrackerAdapter({ apiKey: "k", teamId: "PROJ", teamUuid: "u" })
    await adapter.addIssueLabel("issue-1", "score:7")
    expect(linearClient.addIssueLabel).toHaveBeenCalledWith("k", "PROJ", "issue-1", "score:7")
  })

  test("surfaces tracker errors to the caller", async () => {
    vi.mocked(linearClient.updateIssueState).mockRejectedValueOnce(new Error("upstream 500"))
    const adapter = new LinearTrackerAdapter({ apiKey: "k", teamId: "PROJ", teamUuid: "u" })
    await expect(adapter.updateIssueState("x", "y")).rejects.toThrow(/upstream 500/)
  })
})

describe("LinearWebhookReceiver", () => {
  test("throws with an actionable message when secret is missing", () => {
    expect(() => new LinearWebhookReceiver({ secret: "" })).toThrow(/secret is required/)
  })

  test("delegates verifySignature with the bound secret", async () => {
    const receiver = new LinearWebhookReceiver({ secret: "whsec" })
    const good = await receiver.verifySignature("{}", "good-sig")
    const bad = await receiver.verifySignature("{}", "other")
    expect(good).toBe(true)
    expect(bad).toBe(false)
    expect(webhookHandler.verifyWebhookSignature).toHaveBeenCalledWith("{}", "good-sig", "whsec")
  })

  test("delegates parseEvent and returns null for non-domain payloads", () => {
    const receiver = new LinearWebhookReceiver({ secret: "whsec" })
    expect(receiver.parseEvent("unknown")).toBeNull()
    // With no workflowStates configured, the adapter still translates to a
    // domain event — a content-only `issue.updated` signal.
    const ev = receiver.parseEvent("{}")
    expect(ev).toMatchObject({ kind: "issue.updated", issueId: "issue-1" })
  })

  test("parseEvent maps Linear state IDs to logical IssueStateType when workflowStates is provided", () => {
    const receiver = new LinearWebhookReceiver({
      secret: "whsec",
      workflowStates: {
        todo: "state-todo",
        inProgress: "state-ip",
        done: "state-done",
        cancelled: "state-cancelled",
      },
    })
    const ev = receiver.parseEvent("{}")
    expect(ev).toMatchObject({
      kind: "issue.transitioned",
      from: "todo",
      to: "in_progress",
      issueId: "issue-1",
    })
  })
})

describe("FileSystemWorkspaceGateway", () => {
  test("delegates every WorkspaceGateway method to the underlying WorkspaceManager", async () => {
    const wm = {
      create: vi.fn(async () => ({ ok: "create" })),
      get: vi.fn(async () => ({ ok: "get" })),
      saveAttempt: vi.fn(async () => undefined),
      cleanup: vi.fn(async () => undefined),
      detectUnfinishedWork: vi.fn(async () => ({ hasUncommittedChanges: true, hasCodeChanges: true })),
      autoCommit: vi.fn(async () => ({ ok: true })),
      getDiffStat: vi.fn(async () => "1 file"),
      mergeAndPush: vi.fn(async () => ({ ok: true })),
      pushBranch: vi.fn(async () => ({ ok: true })),
      createDraftPR: vi.fn(async () => ({ created: true, url: "https://example/pr/1" })),
    } as unknown as WorkspaceManager

    const gw = new FileSystemWorkspaceGateway(wm)
    const issue = { id: "i", identifier: "X-1", title: "t" } as never
    const ws = { issueId: "i" } as never

    await gw.create(issue, "/root")
    await gw.get("i", "/root")
    await gw.saveAttempt(ws, { id: "a" } as never)
    await gw.cleanup(ws)
    const unfinished = await gw.detectUnfinishedWork(ws)
    await gw.autoCommit(ws)
    const diff = await gw.getDiffStat(ws)
    await gw.mergeAndPush(ws)
    await gw.pushBranch(ws)
    const pr = await gw.createDraftPR(ws, { title: "t", body: "b" })

    expect(wm.create).toHaveBeenCalledWith(issue, "/root")
    expect(wm.get).toHaveBeenCalledWith("i", "/root")
    expect(wm.saveAttempt).toHaveBeenCalled()
    expect(wm.cleanup).toHaveBeenCalled()
    expect(unfinished).toEqual({ hasUncommittedChanges: true, hasCodeChanges: true })
    expect(wm.autoCommit).toHaveBeenCalled()
    expect(diff).toBe("1 file")
    expect(wm.mergeAndPush).toHaveBeenCalled()
    expect(wm.pushBranch).toHaveBeenCalled()
    expect(pr).toEqual({ created: true, url: "https://example/pr/1" })
    expect(wm.createDraftPR).toHaveBeenCalledWith(ws, { title: "t", body: "b" })
  })
})
