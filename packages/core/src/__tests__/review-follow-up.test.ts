/**
 * ReviewFollowUp unit tests — which pull request reviews reach a running
 * actor or reopen a delivered issue.
 */

import { describe, expect, test, vi } from "vitest"
import type { PullRequestReviewComment } from "../domain/ports/tracker"
import type { InterventionResult } from "../orchestrator/intervention-bus"
import type { SlotDecision } from "../orchestrator/orchestrator-core"
import type { PullRequestReviewEvent, ReviewFollowUpCore } from "../orchestrator/review-follow-up"
import { followUpPullRequestReview } from "../orchestrator/review-follow-up"
import { makeConfig } from "./characterization/helpers"

const REVIEW_URL = "https://github.com/first-fluke/agent-valley/pull/7#pullrequestreview-7001"

function review(overrides: Partial<PullRequestReviewEvent> = {}): PullRequestReviewEvent {
  return {
    kind: "pull_request.reviewed",
    issueId: "42",
    pullNumber: 7,
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
    relay?: { enabled: boolean; pullRequestReviews: boolean; ignoreAuthors?: string[] }
    attemptId?: string
    busResult?: InterventionResult
    slot?: SlotDecision
    labels?: string[]
    comments?: PullRequestReviewComment[] | Error
    updateError?: Error
    enqueued?: boolean
  } = {},
) {
  const relay = options.relay ?? { enabled: true, pullRequestReviews: true }
  const send = vi.fn(async () => options.busResult ?? ({ ok: true } as InterventionResult))
  const tracker = {
    fetchIssueLabels: vi.fn(async () => options.labels ?? ["state-done", "bug"]),
    updateIssueState: vi.fn(async () => {
      if (options.updateError) throw options.updateError
    }),
    addIssueComment: vi.fn(async () => {}),
    fetchPullRequestReviewComments: vi.fn(async () => {
      if (options.comments instanceof Error) throw options.comments
      return options.comments ?? []
    }),
  }
  const enqueueRetry = vi.fn((_issueId: string, _attemptCount: number, _reason: string) => options.enqueued ?? true)
  const removeRetry = vi.fn()
  const core = {
    config: makeConfig({ commentRelay: { ignoreAuthors: [], ...relay } }),
    tracker,
    getAttempt: (issueId: string) => (issueId === "42" ? options.attemptId : undefined),
    getInterventionBus: () => ({ send }),
    canAcceptIssue: () => options.slot ?? ({ ok: true } as SlotDecision),
    enqueueRetry,
    removeRetry,
  } as unknown as ReviewFollowUpCore
  return { core, send, tracker, enqueueRetry, removeRetry }
}

describe("followUpPullRequestReview — running attempt", () => {
  test("relays the review with its inline comments into the running actor", async () => {
    const { core, send, tracker } = harness({
      attemptId: "att-1",
      comments: [
        { path: "src/flags.ts", line: 12, body: "Use the new name here." },
        { path: "README.md", line: null, body: "Document it." },
        { path: "src/empty.ts", line: 1, body: "  " },
      ],
    })

    expect(await followUpPullRequestReview(core, review())).toEqual({ followedUp: "relayed", attemptId: "att-1" })
    expect(tracker.fetchPullRequestReviewComments).toHaveBeenCalledWith(7, "7001")
    expect(send).toHaveBeenCalledWith("att-1", {
      kind: "append_prompt",
      text: [
        `Pull request review from @maintainer (changes requested): ${REVIEW_URL}`,
        "Rename the flag.",
        "Inline comments:\n- src/flags.ts:12: Use the new name here.\n- README.md: Document it.",
      ].join("\n\n"),
    })
    expect(tracker.updateIssueState).not.toHaveBeenCalled()
  })

  test("falls back to the review summary when inline comments cannot be read", async () => {
    const { core, send } = harness({ attemptId: "att-1", comments: new Error("rate limited") })

    expect(await followUpPullRequestReview(core, review())).toMatchObject({ followedUp: "relayed" })
    expect(send).toHaveBeenCalledWith("att-1", {
      kind: "append_prompt",
      text: `Pull request review from @maintainer (changes requested): ${REVIEW_URL}\n\nRename the flag.`,
    })
  })

  test("reports a bus rejection without reopening", async () => {
    const { core, tracker } = harness({
      attemptId: "att-1",
      busResult: { ok: false, reason: "terminated", message: "attempt already ended" },
    })

    expect(await followUpPullRequestReview(core, review())).toEqual({ followedUp: false, reason: "rejected" })
    expect(tracker.updateIssueState).not.toHaveBeenCalled()
  })
})

describe("followUpPullRequestReview — delivered issue", () => {
  test("queues the review as retry context before reopening the issue", async () => {
    const { core, tracker, enqueueRetry } = harness({ comments: [{ path: "src/a.ts", line: 3, body: "Guard null." }] })

    expect(await followUpPullRequestReview(core, review())).toEqual({ followedUp: "reopened" })
    expect(enqueueRetry).toHaveBeenCalledWith("42", 0, expect.stringContaining("- src/a.ts:3: Guard null."))
    expect(enqueueRetry.mock.calls[0]?.[2]).toContain("Address this review in the existing worktree.")
    expect(tracker.updateIssueState).toHaveBeenCalledWith("42", "state-ip")
    expect(enqueueRetry.mock.invocationCallOrder[0]).toBeLessThan(
      tracker.updateIssueState.mock.invocationCallOrder[0] ?? 0,
    )
    expect(tracker.addIssueComment).toHaveBeenCalledWith(
      "42",
      expect.stringMatching(/^Symphony: Review from @maintainer/),
    )
  })

  test("waits for capacity through the retry queue when slots are full", async () => {
    const { core, enqueueRetry } = harness({ slot: { ok: false, reason: "concurrency" } })
    expect(await followUpPullRequestReview(core, review())).toEqual({ followedUp: "reopened" })
    expect(enqueueRetry).toHaveBeenCalled()
  })

  test("leaves preparing, finalizing or recovering work alone", async () => {
    const { core, enqueueRetry } = harness({ slot: { ok: false, reason: "already_active" } })
    expect(await followUpPullRequestReview(core, review())).toEqual({ followedUp: false, reason: "busy" })
    expect(enqueueRetry).not.toHaveBeenCalled()
  })

  test("does not reopen an issue that is not Done", async () => {
    const { core, enqueueRetry } = harness({ labels: ["state-cancelled"] })
    expect(await followUpPullRequestReview(core, review())).toEqual({ followedUp: false, reason: "not_delivered" })
    expect(enqueueRetry).not.toHaveBeenCalled()
  })

  test("drops the queued retry when the issue cannot be reopened", async () => {
    const { core, removeRetry } = harness({ updateError: new Error("GitHub 502") })
    expect(await followUpPullRequestReview(core, review())).toEqual({ followedUp: false, reason: "reopen_failed" })
    expect(removeRetry).toHaveBeenCalledWith("42")
  })

  test("does not reopen when the retry budget refuses the entry", async () => {
    const { core, tracker } = harness({ enqueued: false })
    expect(await followUpPullRequestReview(core, review())).toEqual({ followedUp: false, reason: "reopen_failed" })
    expect(tracker.updateIssueState).not.toHaveBeenCalled()
  })
})

describe("followUpPullRequestReview — filters", () => {
  test("does nothing unless comment relay and pull request reviews are both on", async () => {
    for (const relay of [
      { enabled: true, pullRequestReviews: false },
      { enabled: false, pullRequestReviews: true },
    ]) {
      const { core, send, enqueueRetry } = harness({ relay, attemptId: "att-1" })
      expect(await followUpPullRequestReview(core, review())).toEqual({ followedUp: false, reason: "disabled" })
      expect(send).not.toHaveBeenCalled()
      expect(enqueueRetry).not.toHaveBeenCalled()
    }
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
        attemptId: "att-1",
        relay: { enabled: true, pullRequestReviews: true, ignoreAuthors: ["release-bot"] },
      })
      expect(await followUpPullRequestReview(core, review(overrides))).toEqual({ followedUp: false, reason })
      expect(send).not.toHaveBeenCalled()
    }
  })

  test("ignores approvals and reviews with nothing to act on", async () => {
    const approved = harness({ attemptId: "att-1" })
    expect(await followUpPullRequestReview(approved.core, review({ verdict: "approved" }))).toEqual({
      followedUp: false,
      reason: "approved",
    })

    const empty = harness({ attemptId: "att-1" })
    expect(await followUpPullRequestReview(empty.core, review({ verdict: "commented", body: " " }))).toEqual({
      followedUp: false,
      reason: "empty",
    })
    expect(empty.send).not.toHaveBeenCalled()
  })
})
