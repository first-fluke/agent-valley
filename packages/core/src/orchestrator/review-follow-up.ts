/**
 * ReviewFollowUp — turns a submitted review of an Agent Valley pull request
 * into follow-up work on the issue that pull request delivers.
 *
 * - A running attempt receives the review through the InterventionBus as an
 *   `append_prompt`, the same path a relayed issue comment takes.
 * - A delivered issue (PR mode leaves it Done with its worktree in place) is
 *   reopened: the review is queued as retry context first, then the issue
 *   moves to In Progress. The retry dispatch resumes the existing branch
 *   with the review in its prompt, and delivery pushes to the same pull
 *   request. The In Progress webhook caused by this transition is skipped
 *   while the retry is queued (IssueLifecycle.handleIssueInProgress).
 *
 * Only maintainers' reviews count, and approvals carry nothing to act on.
 * Review text is untrusted input (docs/harness/SAFETY.md §3); the prompt
 * renderer sanitizes and fences retry context.
 */

import type { ParsedWebhookEvent } from "../domain/parsed-webhook-event"
import type { PullRequestReviewComment } from "../domain/ports/tracker"
import { logger } from "../observability/logger"
import { isIgnoredAuthor } from "./comment-relay"
import type { OrchestratorCore } from "./orchestrator-core"

export type PullRequestReviewEvent = Extract<ParsedWebhookEvent, { kind: "pull_request.reviewed" }>

export type ReviewFollowUpSkipReason =
  | "disabled"
  | "own_review"
  | "untrusted_reviewer"
  | "ignored_reviewer"
  | "approved"
  | "empty"
  | "busy"
  | "not_delivered"
  | "rejected"
  | "reopen_failed"

export type ReviewFollowUpOutcome =
  | { followedUp: "relayed"; attemptId: string }
  | { followedUp: "reopened" }
  | { followedUp: false; reason: ReviewFollowUpSkipReason }

export type ReviewFollowUpCore = Pick<
  OrchestratorCore,
  "config" | "tracker" | "getAttempt" | "getInterventionBus" | "canAcceptIssue" | "enqueueRetry" | "removeRetry"
>

/** Keeps a long review from bloating the prompt and the persisted retry queue. */
const MAX_REVIEW_LENGTH = 16_000

const REOPEN_INSTRUCTION =
  "Address this review in the existing worktree. Agent Valley verifies the result and pushes it to the same pull request."

export async function followUpPullRequestReview(
  core: ReviewFollowUpCore,
  event: PullRequestReviewEvent,
): Promise<ReviewFollowUpOutcome> {
  const policy = core.config.commentRelay
  if (!policy?.enabled || !policy.pullRequestReviews) return skip(event, "disabled")
  if (event.fromAgentValley) return skip(event, "own_review")
  if (event.reviewerTrust !== "maintainer") return skip(event, "untrusted_reviewer")
  if (isIgnoredAuthor(policy.ignoreAuthors, event.reviewerKeys)) return skip(event, "ignored_reviewer")
  if (event.verdict === "approved") return skip(event, "approved")

  const comments = await fetchInlineComments(core, event)
  if (!event.body.trim() && comments.length === 0) return skip(event, "empty")
  const review = formatReview(event, comments)

  const attemptId = core.getAttempt(event.issueId)
  const bus = core.getInterventionBus()
  if (attemptId && bus) {
    const result = await bus.send(attemptId, { kind: "append_prompt", text: review })
    if (!result.ok) {
      logger.warn("orchestrator", "Pull request review not relayed to the running actor", {
        ...logContext(event),
        attemptId,
        reason: result.reason,
        detail: result.message,
      })
      return { followedUp: false, reason: "rejected" }
    }
    logger.info("orchestrator", "Relayed pull request review to the running actor", { ...logContext(event), attemptId })
    return { followedUp: "relayed", attemptId }
  }

  // Preparing, finalizing or recovering work would race a reopen. A full
  // slot table is fine: the queued retry waits for capacity.
  const slot = core.canAcceptIssue(event.issueId)
  if (!slot.ok && slot.reason !== "concurrency") return skip(event, "busy")

  const { done, inProgress } = core.config.workflowStates
  try {
    // Pull requests only exist on the GitHub tracker, where the workflow
    // state is a label.
    const labels = await core.tracker.fetchIssueLabels(event.issueId)
    if (!labels.includes(done)) return skip(event, "not_delivered")
  } catch (err) {
    logger.warn("orchestrator", "Pull request review follow-up could not read the issue state", {
      ...logContext(event),
      error: String(err),
    })
    return { followedUp: false, reason: "reopen_failed" }
  }

  // Queue first so the In Progress webhook from the transition below finds
  // the retry and leaves the dispatch to it.
  if (!core.enqueueRetry(event.issueId, 0, `${review}\n\n${REOPEN_INSTRUCTION}`)) {
    return { followedUp: false, reason: "reopen_failed" }
  }
  try {
    await core.tracker.updateIssueState(event.issueId, inProgress)
  } catch (err) {
    core.removeRetry(event.issueId)
    logger.warn("orchestrator", "Pull request review follow-up could not reopen the issue", {
      ...logContext(event),
      error: String(err),
    })
    return { followedUp: false, reason: "reopen_failed" }
  }

  logger.info("orchestrator", "Reopened delivered issue for pull request review", logContext(event))
  core.tracker
    .addIssueComment(
      event.issueId,
      `Symphony: Review from @${event.reviewer} on ${event.url || `PR #${event.pullNumber}`} — reopening to address it.`,
    )
    .catch((err) => {
      logger.debug("orchestrator", "Failed to post review follow-up comment", { error: String(err) })
    })
  return { followedUp: "reopened" }
}

async function fetchInlineComments(
  core: ReviewFollowUpCore,
  event: PullRequestReviewEvent,
): Promise<PullRequestReviewComment[]> {
  if (!core.tracker.fetchPullRequestReviewComments) return []
  try {
    const comments = await core.tracker.fetchPullRequestReviewComments(event.pullNumber, event.reviewId)
    return comments.filter((comment) => comment.body.trim())
  } catch (err) {
    logger.warn("orchestrator", "Pull request review comments unavailable; using the review summary only", {
      ...logContext(event),
      error: String(err),
    })
    return []
  }
}

/** Inline comments belong to the same reviewer, so they share the review's trust check. */
function formatReview(event: PullRequestReviewEvent, comments: PullRequestReviewComment[]): string {
  const verdict = event.verdict === "changes_requested" ? "changes requested" : "comments"
  const sections = [`Pull request review from @${event.reviewer} (${verdict}): ${event.url || `#${event.pullNumber}`}`]
  if (event.body.trim()) sections.push(event.body.trim())
  if (comments.length > 0) {
    const lines = comments.map((comment) => {
      const where = comment.line === null ? comment.path : `${comment.path}:${comment.line}`
      return `- ${where}: ${comment.body.trim()}`
    })
    sections.push(`Inline comments:\n${lines.join("\n")}`)
  }
  const text = sections.join("\n\n")
  return text.length > MAX_REVIEW_LENGTH ? `${text.slice(0, MAX_REVIEW_LENGTH)}\n[review truncated]` : text
}

function logContext(event: PullRequestReviewEvent) {
  return { issueId: event.issueId, pullNumber: event.pullNumber, reviewId: event.reviewId }
}

function skip(event: PullRequestReviewEvent, reason: ReviewFollowUpSkipReason): ReviewFollowUpOutcome {
  logger.debug("orchestrator", `Pull request review not followed up: ${reason}`, logContext(event))
  return { followedUp: false, reason }
}
