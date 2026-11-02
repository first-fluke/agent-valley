/**
 * CommentRelay — decides whether a tracker comment reaches the actor that is
 * working on its issue, and forwards it through the InterventionBus as an
 * `append_prompt`.
 *
 * Only maintainers' comments on an issue with a running attempt are relayed.
 * Agent Valley's own comments, bots, configured authors and external authors
 * are dropped: comment text is untrusted input (docs/harness/SAFETY.md §3),
 * and relaying our own messages would feed the actor back into itself.
 *
 * Stateless actors (claude, ...) receive the comment through the bus's
 * cancel + retry fallback, so a relayed comment restarts their attempt.
 */

import type { ParsedWebhookEvent } from "../domain/parsed-webhook-event"
import { logger } from "../observability/logger"
import type { OrchestratorCore } from "./orchestrator-core"

export type IssueCommentEvent = Extract<ParsedWebhookEvent, { kind: "issue.commented" }>

export type CommentRelaySkipReason =
  | "disabled"
  | "own_comment"
  | "untrusted_author"
  | "ignored_author"
  | "empty"
  | "no_running_attempt"
  | "rejected"

export type CommentRelayOutcome =
  | { relayed: true; attemptId: string }
  | { relayed: false; reason: CommentRelaySkipReason }

export type CommentRelayCore = Pick<OrchestratorCore, "config" | "getAttempt" | "getInterventionBus">

export async function relayIssueComment(
  core: CommentRelayCore,
  event: IssueCommentEvent,
): Promise<CommentRelayOutcome> {
  const policy = core.config.github?.commentRelay
  if (!policy?.enabled) return skip(event, "disabled")
  if (event.fromAgentValley) return skip(event, "own_comment")
  if (event.authorTrust !== "maintainer") return skip(event, "untrusted_author")
  // GitHub logins are case-insensitive.
  const author = event.author.toLowerCase()
  if (policy.ignoreAuthors.some((login) => login.toLowerCase() === author)) return skip(event, "ignored_author")
  if (!event.body.trim()) return skip(event, "empty")

  const attemptId = core.getAttempt(event.issueId)
  const bus = core.getInterventionBus()
  if (!attemptId || !bus) return skip(event, "no_running_attempt")

  const result = await bus.send(attemptId, {
    kind: "append_prompt",
    text: `Issue comment from @${event.author}:\n${event.body}`,
  })
  if (!result.ok) {
    logger.warn("orchestrator", "Issue comment not relayed to the running actor", {
      issueId: event.issueId,
      commentId: event.commentId,
      attemptId,
      reason: result.reason,
      detail: result.message,
    })
    return { relayed: false, reason: "rejected" }
  }

  logger.info("orchestrator", "Relayed issue comment to the running actor", {
    issueId: event.issueId,
    commentId: event.commentId,
    attemptId,
  })
  return { relayed: true, attemptId }
}

function skip(event: IssueCommentEvent, reason: CommentRelaySkipReason): CommentRelayOutcome {
  logger.debug("orchestrator", `Issue comment not relayed: ${reason}`, {
    issueId: event.issueId,
    commentId: event.commentId,
  })
  return { relayed: false, reason }
}
