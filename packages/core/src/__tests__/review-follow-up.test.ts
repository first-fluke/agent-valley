/**
 * ReviewFollowUp unit tests — which pull request reviews reach a running
 * actor or reopen a delivered issue, whichever service tracks the issue.
 */

import { describe, expect, test, vi } from "vitest"
import type { Issue, Workspace } from "../domain/models"
import type { CodeHost, PullRequestReviewComment } from "../domain/ports/code-host"
import type { InterventionResult } from "../orchestrator/intervention-bus"
import type { SlotDecision } from "../orchestrator/orchestrator-core"
import type { PullRequestReviewEvent, ReviewFollowUpCore } from "../orchestrator/review-follow-up"
import { followUpPullRequestReview } from "../orchestrator/review-follow-up"
import { makeConfig, makeIssue } from "./characterization/helpers"

const REVIEW_URL = "https://github.com/first-fluke/agent-valley/pull/7#pullrequestreview-7001"

const DELIVERED = makeIssue({
  id: "uuid-42",
  identifier: "ACR-42",
  status: { id: "state-done", name: "Done", type: "completed" },
})

function review(overrides: Partial<PullRequestReviewEvent> = {}): PullRequestReviewEvent {
  return {
    kind: "pull_request.reviewed",
    repository: "first-fluke/agent-valley",
    pullNumber: 7,
    headBranch: "feature/ACR-42",
    issueIdentifier: "ACR-42",
    reviewId: "7001",
    reviewer: "maintainer",
    reviewerKeys: ["maintainer"],
    reviewerTrust: "maintainer",
    verdict: "changes_requested",
    fromAgentValley: false,
    body: "Rename the flag.",
    url: REVIEW_URL,
    ...overrides,
  }
}

function harness(
  options: {
    policy?: { enabled: boolean; ignoreAuthors?: string[] }
    /** Issue running on the reviewed branch. */
    running?: { issueId: string; attemptId?: string }
    busResult?: InterventionResult
    slot?: SlotDecision
    issue?: Issue | null | Error
    comments?: PullRequestReviewComment[] | Error
    updateError?: Error
    enqueued?: boolean
  } = {},
) {
  const send = vi.fn(async () => options.busResult ?? ({ ok: true } as InterventionResult))
  const tracker = {
    findIssueByIdentifier: vi.fn(async (_identifier: string) => {
      if (options.issue instanceof Error) throw options.issue
      return options.issue === undefined ? DELIVERED : options.issue
    }),
    updateIssueState: vi.fn(async () => {
      if (options.updateError) throw options.updateError
    }),
    addIssueComment: vi.fn(async () => {}),
  }
  const codeHost = {
    fetchPullRequestReviewComments: vi.fn(async () => {
      if (options.comments instanceof Error) throw options.comments
      return options.comments ?? []
    }),
  } satisfies CodeHost
  const activeWorkspaces = new Map<string, Workspace>()
  if (options.running) {
    activeWorkspaces.set(options.running.issueId, { branch: "feature/ACR-42" } as Workspace)
  }
  const enqueueRetry = vi.fn((_issueId: string, _attemptCount: number, _reason: string) => options.enqueued ?? true)
  const removeRetry = vi.fn()
  const policy = options.policy ?? { enabled: true }
  const core = {
    config: makeConfig({ pullRequestReviews: { webhookSecret: "whsec", ignoreAuthors: [], ...policy } }),
    tracker,
    state: { activeWorkspaces },
    getAttempt: (issueId: string) => (issueId === options.running?.issueId ? options.running.attemptId : undefined),
    getInterventionBus: () => ({ send }),
    canAcceptIssue: () => options.slot ?? ({ ok: true } as SlotDecision),
    enqueueRetry,
    removeRetry,
  } as unknown as ReviewFollowUpCore
  return { core, codeHost, send, tracker, enqueueRetry, removeRetry }
}

describe("followUpPullRequestReview — running attempt", () => {
  test("relays the review with its inline comments to the actor working on the branch", async () => {
    const { core, codeHost, send, tracker } = harness({
      running: { issueId: "uuid-42", attemptId: "att-1" },
      comments: [
        { path: "src/flags.ts", line: 12, body: "Use the new name here." },
        { path: "README.md", line: null, body: "Document it." },
        { path: "src/empty.ts", line: 1, body: "  " },
      ],
    })

    expect(await followUpPullRequestReview(core, review(), codeHost)).toEqual({
      followedUp: "relayed",
      attemptId: "att-1",
    })
    expect(codeHost.fetchPullRequestReviewComments).toHaveBeenCalledWith("first-fluke/agent-valley", 7, "7001")
    expect(send).toHaveBeenCalledWith("att-1", {
      kind: "append_prompt",
      text: [
        `Pull request review from @maintainer (changes requested): ${REVIEW_URL}`,
        "Rename the flag.",
        "Inline comments:\n- src/flags.ts:12: Use the new name here.\n- README.md: Document it.",
      ].join("\n\n"),
    })
    expect(tracker.findIssueByIdentifier).not.toHaveBeenCalled()
  })

  test("uses the review summary alone without a code host or when its comments fail", async () => {
    const summary = `Pull request review from @maintainer (changes requested): ${REVIEW_URL}\n\nRename the flag.`
    const withoutHost = harness({ running: { issueId: "uuid-42", attemptId: "att-1" } })
    expect(await followUpPullRequestReview(withoutHost.core, review())).toMatchObject({ followedUp: "relayed" })
    expect(withoutHost.send).toHaveBeenCalledWith("att-1", { kind: "append_prompt", text: summary })

    const failing = harness({ running: { issueId: "uuid-42", attemptId: "att-1" }, comments: new Error("401") })
    expect(await followUpPullRequestReview(failing.core, review(), failing.codeHost)).toMatchObject({
      followedUp: "relayed",
    })
    expect(failing.send).toHaveBeenCalledWith("att-1", { kind: "append_prompt", text: summary })
  })

  test("leaves a workspace whose actor has not started yet", async () => {
    const { core, send, enqueueRetry } = harness({ running: { issueId: "uuid-42" } })
    expect(await followUpPullRequestReview(core, review())).toEqual({ followedUp: false, reason: "busy" })
    expect(send).not.toHaveBeenCalled()
    expect(enqueueRetry).not.toHaveBeenCalled()
  })

  test("reports a bus rejection without reopening", async () => {
    const { core, tracker } = harness({
      running: { issueId: "uuid-42", attemptId: "att-1" },
      busResult: { ok: false, reason: "terminated", message: "attempt already ended" },
    })
    expect(await followUpPullRequestReview(core, review())).toEqual({ followedUp: false, reason: "rejected" })
    expect(tracker.updateIssueState).not.toHaveBeenCalled()
  })
})

describe("followUpPullRequestReview — delivered issue", () => {
  test("queues the review as retry context before reopening the tracker issue", async () => {
    const { core, codeHost, tracker, enqueueRetry } = harness({
      comments: [{ path: "src/a.ts", line: 3, body: "Guard null." }],
    })

    expect(await followUpPullRequestReview(core, review(), codeHost)).toEqual({
      followedUp: "reopened",
      issueId: "uuid-42",
    })
    expect(tracker.findIssueByIdentifier).toHaveBeenCalledWith("ACR-42")
    expect(enqueueRetry).toHaveBeenCalledWith("uuid-42", 0, expect.stringContaining("- src/a.ts:3: Guard null."))
    expect(enqueueRetry.mock.calls[0]?.[2]).toContain("Address this review in the existing worktree.")
    expect(tracker.updateIssueState).toHaveBeenCalledWith("uuid-42", "state-ip")
    expect(enqueueRetry.mock.invocationCallOrder[0]).toBeLessThan(
      tracker.updateIssueState.mock.invocationCallOrder[0] ?? 0,
    )
    expect(tracker.addIssueComment).toHaveBeenCalledWith(
      "uuid-42",
      expect.stringMatching(/^Symphony: Review from @maintainer/),
    )
  })

  test("waits for capacity through the retry queue when slots are full", async () => {
    const { core, enqueueRetry } = harness({ slot: { ok: false, reason: "concurrency" } })
    expect(await followUpPullRequestReview(core, review())).toMatchObject({ followedUp: "reopened" })
    expect(enqueueRetry).toHaveBeenCalled()
  })

  test("leaves preparing, finalizing or recovering work alone", async () => {
    const { core, enqueueRetry } = harness({ slot: { ok: false, reason: "already_active" } })
    expect(await followUpPullRequestReview(core, review())).toEqual({ followedUp: false, reason: "busy" })
    expect(enqueueRetry).not.toHaveBeenCalled()
  })

  test("skips branches whose identifier the tracker does not know", async () => {
    const { core, codeHost, enqueueRetry } = harness({ issue: null })
    expect(await followUpPullRequestReview(core, review({ issueIdentifier: "login" }), codeHost)).toEqual({
      followedUp: false,
      reason: "unknown_issue",
    })
    expect(codeHost.fetchPullRequestReviewComments).not.toHaveBeenCalled()
    expect(enqueueRetry).not.toHaveBeenCalled()
  })

  test("does not reopen an issue that is not Done", async () => {
    const { core, enqueueRetry } = harness({
      issue: makeIssue({ id: "uuid-42", status: { id: "state-cancelled", name: "Cancelled", type: "canceled" } }),
    })
    expect(await followUpPullRequestReview(core, review())).toEqual({ followedUp: false, reason: "not_delivered" })
    expect(enqueueRetry).not.toHaveBeenCalled()
  })

  test("reports tracker lookup failures", async () => {
    const { core } = harness({ issue: new Error("Linear 503") })
    expect(await followUpPullRequestReview(core, review())).toEqual({ followedUp: false, reason: "reopen_failed" })
  })

  test("drops the queued retry when the issue cannot be reopened", async () => {
    const { core, removeRetry } = harness({ updateError: new Error("Linear 502") })
    expect(await followUpPullRequestReview(core, review())).toEqual({ followedUp: false, reason: "reopen_failed" })
    expect(removeRetry).toHaveBeenCalledWith("uuid-42")
  })

  test("does not reopen when the retry budget refuses the entry", async () => {
    const { core, tracker } = harness({ enqueued: false })
    expect(await followUpPullRequestReview(core, review())).toEqual({ followedUp: false, reason: "reopen_failed" })
    expect(tracker.updateIssueState).not.toHaveBeenCalled()
  })
})

describe("followUpPullRequestReview — filters", () => {
  test("does nothing while pull request reviews are off or unconfigured", async () => {
    const off = harness({ policy: { enabled: false }, running: { issueId: "uuid-42", attemptId: "att-1" } })
    expect(await followUpPullRequestReview(off.core, review())).toEqual({ followedUp: false, reason: "disabled" })
    expect(off.send).not.toHaveBeenCalled()

    const unconfigured = harness()
    ;(unconfigured.core.config as { pullRequestReviews?: unknown }).pullRequestReviews = undefined
    expect(await followUpPullRequestReview(unconfigured.core, review())).toEqual({
      followedUp: false,
      reason: "disabled",
    })
  })

  test("drops own, external, bot and ignored reviewers", async () => {
    const cases: Array<[Partial<PullRequestReviewEvent>, string]> = [
      [{ fromAgentValley: true }, "own_review"],
      [{ reviewerTrust: "external" }, "untrusted_reviewer"],
      [{ reviewerTrust: "bot" }, "untrusted_reviewer"],
      [{ reviewerKeys: ["Release-Bot"] }, "ignored_reviewer"],
    ]
    for (const [overrides, reason] of cases) {
      const { core, send } = harness({
        running: { issueId: "uuid-42", attemptId: "att-1" },
        policy: { enabled: true, ignoreAuthors: ["release-bot"] },
      })
      expect(await followUpPullRequestReview(core, review(overrides))).toEqual({ followedUp: false, reason })
      expect(send).not.toHaveBeenCalled()
    }
  })

  test("ignores approvals and reviews with nothing to act on", async () => {
    const approved = harness({ running: { issueId: "uuid-42", attemptId: "att-1" } })
    expect(await followUpPullRequestReview(approved.core, review({ verdict: "approved" }))).toEqual({
      followedUp: false,
      reason: "approved",
    })

    const empty = harness({ running: { issueId: "uuid-42", attemptId: "att-1" } })
    expect(await followUpPullRequestReview(empty.core, review({ verdict: "commented", body: " " }))).toEqual({
      followedUp: false,
      reason: "empty",
    })
    expect(empty.send).not.toHaveBeenCalled()
  })
})
