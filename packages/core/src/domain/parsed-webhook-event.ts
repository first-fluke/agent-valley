/**
 * ParsedWebhookEvent — tracker-agnostic domain event emitted by
 * WebhookReceiver adapters (Linear, GitHub, ...).
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 4.2 (PR4 domain promotion).
 *
 * The shape extends the minimal sketch in the design doc with an `issue`
 * envelope on `issue.transitioned` and `issue.updated`. Adapters already
 * have the full Issue in the webhook payload; carrying it on the domain
 * event avoids a round-trip back through the IssueTracker just to resolve
 * identifier / title / labels in the Orchestrator.
 *
 * Invariant: this file does not import from outside `domain/`. Validated
 * by scripts/harness/validate.sh.
 */

import type { Issue } from "./models"
import type { IssueStateType } from "./ports/tracker"

/** Kind discriminant for the domain event union. */
export type ParsedWebhookEventKind =
  | "issue.transitioned"
  | "issue.updated"
  | "issue.deleted"
  | "issue.labeled"
  | "issue.relation_changed"
  | "issue.commented"
  | "pull_request.reviewed"

/**
 * Hidden marker appended to every GitHub comment Agent Valley posts, so
 * comment webhooks can tell its own messages from people's.
 */
export const AGENT_VALLEY_COMMENT_MARKER = "<!-- agent-valley -->"

/** Prefix of every comment Agent Valley posts on any tracker. */
export const AGENT_VALLEY_COMMENT_PREFIX = "Symphony:"

/**
 * True for a comment body Agent Valley wrote. Trackers that rebuild
 * Markdown (Linear) may drop the hidden marker, so the prefix also counts.
 */
export function isAgentValleyCommentBody(body: string): boolean {
  return body.includes(AGENT_VALLEY_COMMENT_MARKER) || body.trimStart().startsWith(AGENT_VALLEY_COMMENT_PREFIX)
}

/**
 * Tracker-reported standing of a comment author. `maintainer` covers
 * repository owners, organization members and collaborators.
 */
export type CommentAuthorTrust = "maintainer" | "external" | "bot"

/** Outcome a reviewer chose when submitting a pull request review. */
export type PullRequestReviewVerdict = "approved" | "changes_requested" | "commented"

export type ParsedWebhookEvent =
  | {
      kind: "issue.transitioned"
      issueId: string
      /** Null when the tracker did not report a prior state (e.g. fresh create). */
      from: IssueStateType | null
      to: IssueStateType
      /** Full issue envelope for downstream dispatch; avoids a round-trip fetch. */
      issue: Issue
    }
  | {
      kind: "issue.updated"
      issueId: string
      changedFields: string[]
      issue: Issue
    }
  | {
      kind: "issue.deleted"
      issueId: string
    }
  | {
      kind: "issue.labeled"
      issueId: string
      label: string
      issue: Issue
    }
  | {
      kind: "issue.relation_changed"
      issueId: string
      relation: "blocked_by" | "blocks"
      relatedIssueId: string
      /** true = relation added, false = relation removed. */
      added: boolean
    }
  | {
      kind: "issue.commented"
      issueId: string
      commentId: string
      /** Author display handle as reported by the tracker. */
      author: string
      /** Identifiers `ignore_authors` may name: GitHub login; Linear email, user id and name. */
      authorKeys: string[]
      authorTrust: CommentAuthorTrust
      /** True when `isAgentValleyCommentBody` matches the raw body. */
      fromAgentValley: boolean
      /** Boundary-sanitized comment text; still untrusted input. */
      body: string
    }
  | {
      kind: "pull_request.reviewed"
      /** Repository hosting the pull request, `owner/name`; may differ from the tracker. */
      repository: string
      pullNumber: number
      /** Head branch of the open pull request. */
      headBranch: string
      /** Identifier read from an Agent Valley branch `<prefix>/<identifier>` (ACR-42, owner/repo#42). */
      issueIdentifier: string
      reviewId: string
      reviewer: string
      /** Identifiers `ignore_authors` may name (GitHub login). */
      reviewerKeys: string[]
      reviewerTrust: CommentAuthorTrust
      verdict: PullRequestReviewVerdict
      /** True when `isAgentValleyCommentBody` matches the raw review body. */
      fromAgentValley: boolean
      /** Boundary-sanitized review summary; may be empty when the review only has inline comments. */
      body: string
      url: string
    }
