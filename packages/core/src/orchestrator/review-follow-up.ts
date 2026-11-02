/**
 * ReviewFollowUp — turns a submitted review of an Agent Valley pull request
 * into follow-up work on the issue that pull request delivers.
 *
 * The pull request lives on the code host (GitHub); the issue may live on
 * another tracker (Linear). The branch links them: Agent Valley names it
 * `<prefix>/<issue identifier>`.
 *
 * - A running attempt on that branch receives the review through the
 *   InterventionBus as an `append_prompt`, like a relayed issue comment.
 * - A delivered issue (PR mode leaves it Done with its worktree in place) is
 *   reopened: the review is queued as retry context first, then the issue
 *   moves to In Progress. The retry dispatch resumes the existing branch
 *   with the review in its prompt, and delivery pushes to the same pull
 *   request. Webhooks caused by this transition are skipped while the
 *   retry is queued (IssueLifecycle.handleIssueTodo / handleIssueInProgress).
 *
 * Only maintainers' reviews count, and approvals carry nothing to act on.
 * Review text is untrusted input (docs/harness/SAFETY.md §3); the prompt
 * renderer sanitizes and fences retry context.
 */

import type { Issue } from "../domain/models"
import type { ParsedWebhookEvent } from "../domain/parsed-webhook-event"
import type { CodeHost, PullRequestReviewComment } from "../domain/ports/code-host"
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
  | "unknown_issue"
  | "empty"
  | "busy"
  | "not_delivered"
  | "rejected"
  | "reopen_failed"

export type ReviewFollowUpOutcome =
  | { followedUp: "relayed"; attemptId: string }
  | { followedUp: "reopened"; issueId: string }
  | { followedUp: false; reason: ReviewFollowUpSkipReason }

export type ReviewFollowUpCore = Pick<
  OrchestratorCore,
  | "config"
  | "tracker"
  | "state"
  | "getAttempt"
  | "getInterventionBus"
  | "canAcceptIssue"
  | "enqueueRetry"
  | "removeRetry"
>

/** Keeps a long review from bloating the prompt and the persisted retry queue. */
const MAX_REVIEW_LENGTH = 16_000

const REOPEN_INSTRUCTION =
  "Address this review in the existing worktree. Agent Valley verifies the result and pushes it to the same pull request."

export async function followUpPullRequestReview(
  core: ReviewFollowUpCore,
  event: PullRequestReviewEvent,
  codeHost: CodeHost | null = null,
): Promise<ReviewFollowUpOutcome> {
  const policy = core.config.pullRequestReviews
  if (!policy?.enabled) return skip(event, "disabled")
  if (event.fromAgentValley) return skip(event, "own_review")
  if (event.reviewerTrust !== "maintainer") return skip(event, "untrusted_reviewer")
  if (isIgnoredAuthor(policy.ignoreAuthors, event.reviewerKeys)) return skip(event, "ignored_reviewer")
  if (event.verdict === "approved") return skip(event, "approved")

  const runningIssueId = issueWorkingOnBranch(core, event.headBranch)
  if (runningIssueId) return relayToRunningAttempt(core, event, codeHost, runningIssueId)

  let issue: Issue | null = null
  try {
    issue = (await core.tracker.findIssueByIdentifier?.(event.issueIdentifier)) ?? null
  } catch (err) {
    logger.warn("orchestrator", "Pull request review follow-up could not look up the issue", {
      ...logContext(event),
      error: String(err),
    })
    return { followedUp: false, reason: "reopen_failed" }
  }
  if (!issue) return skip(event, "unknown_issue")

  // Preparing, finalizing or recovering work would race a reopen. A full
  // slot table is fine: the queued retry waits for capacity.
  const slot = core.canAcceptIssue(issue.id)
  if (!slot.ok && slot.reason !== "concurrency") return skip(event, "busy")
  if (issue.status.id !== core.config.workflowStates.done) return skip(event, "not_delivered")

  const review = await buildReview(event, codeHost)
  if (!review) return skip(event, "empty")
  return reopenDeliveredIssue(core, event, issue, review)
}

async function relayToRunningAttempt(
  core: ReviewFollowUpCore,
  event: PullRequestReviewEvent,
  codeHost: CodeHost | null,
  issueId: string,
): Promise<ReviewFollowUpOutcome> {
  const attemptId = core.getAttempt(issueId)
  const bus = core.getInterventionBus()
  // The workspace exists but the actor has not started yet.
  if (!attemptId || !bus) return skip(event, "busy")

  const review = await buildReview(event, codeHost)
  if (!review) return skip(event, "empty")
  const result = await bus.send(attemptId, { kind: "append_prompt", text: review })
  if (!result.ok) {
    logger.warn("orchestrator", "Pull request review not relayed to the running actor", {
      ...logContext(event),
      issueId,
      attemptId,
      reason: result.reason,
      detail: result.message,
    })
    return { followedUp: false, reason: "rejected" }
  }
  logger.info("orchestrator", "Relayed pull request review to the running actor", {
    ...logContext(event),
    issueId,
    attemptId,
  })
  return { followedUp: "relayed", attemptId }
}

async function reopenDeliveredIssue(
  core: ReviewFollowUpCore,
  event: PullRequestReviewEvent,
  issue: Issue,
  review: string,
): Promise<ReviewFollowUpOutcome> {
  // Queue first so the webhooks from the transition below find the retry
  // and leave the dispatch to it.
  if (!core.enqueueRetry(issue.id, 0, `${review}\n\n${REOPEN_INSTRUCTION}`)) {
    return { followedUp: false, reason: "reopen_failed" }
  }
  try {
    await core.tracker.updateIssueState(issue.id, core.config.workflowStates.inProgress)
  } catch (err) {
    core.removeRetry(issue.id)
    logger.warn("orchestrator", "Pull request review follow-up could not reopen the issue", {
      ...logContext(event),
      issueId: issue.id,
      error: String(err),
    })
    return { followedUp: false, reason: "reopen_failed" }
  }

  logger.info("orchestrator", "Reopened delivered issue for pull request review", {
    ...logContext(event),
    issueId: issue.id,
  })
  core.tracker
    .addIssueComment(
      issue.id,
      `Symphony: Review from @${event.reviewer} on ${pullRequestLink(event)} — reopening to address it.`,
    )
    .catch((err) => {
      logger.debug("orchestrator", "Failed to post review follow-up comment", { error: String(err) })
    })
  return { followedUp: "reopened", issueId: issue.id }
}

function issueWorkingOnBranch(core: ReviewFollowUpCore, branch: string): string | undefined {
  for (const [issueId, workspace] of core.state.activeWorkspaces) {
    if (workspace.branch === branch) return issueId
  }
  return undefined
}

/** Review text for the actor, or null when there is nothing to act on. */
async function buildReview(event: PullRequestReviewEvent, codeHost: CodeHost | null): Promise<string | null> {
  const comments = await fetchInlineComments(event, codeHost)
  if (!event.body.trim() && comments.length === 0) return null
  // Inline comments belong to the same reviewer, so they share the review's trust check.
  const verdict = event.verdict === "changes_requested" ? "changes requested" : "comments"
  const sections = [`Pull request review from @${event.reviewer} (${verdict}): ${pullRequestLink(event)}`]
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

async function fetchInlineComments(
  event: PullRequestReviewEvent,
  codeHost: CodeHost | null,
): Promise<PullRequestReviewComment[]> {
  if (!codeHost) return []
  try {
    const comments = await codeHost.fetchPullRequestReviewComments(event.repository, event.pullNumber, event.reviewId)
    return comments.filter((comment) => comment.body.trim())
  } catch (err) {
    logger.warn("orchestrator", "Pull request review comments unavailable; using the review summary only", {
      ...logContext(event),
      error: String(err),
    })
    return []
  }
}

function pullRequestLink(event: PullRequestReviewEvent): string {
  return event.url || `${event.repository}#${event.pullNumber}`
}

function logContext(event: PullRequestReviewEvent) {
  return {
    repository: event.repository,
    pullNumber: event.pullNumber,
    reviewId: event.reviewId,
    issueIdentifier: event.issueIdentifier,
  }
}

function skip(event: PullRequestReviewEvent, reason: ReviewFollowUpSkipReason): ReviewFollowUpOutcome {
  logger.debug("orchestrator", `Pull request review not followed up: ${reason}`, logContext(event))
  return { followedUp: false, reason }
}
