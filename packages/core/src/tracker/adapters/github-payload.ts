/**
 * GitHub webhook payload helpers shared by the GitHub tracker receiver and
 * the pull-request-review receiver used when another service tracks issues.
 *
 * Prompt-injection defense: comment and review text is untrusted. The
 * boundary sanitize here strips control characters and prompt boundary
 * markers; the comprehensive sanitize runs at prompt-render time via
 * `config/workflow-loader.ts::sanitizeIssueBody`.
 */

import {
  type CommentAuthorTrust,
  isAgentValleyCommentBody,
  type ParsedWebhookEvent,
  type PullRequestReviewVerdict,
} from "../../domain/parsed-webhook-event"

export interface GithubCommentPayload {
  id?: number
  body?: string | null
  user?: { login?: string; type?: string }
  author_association?: string
  performed_via_github_app?: unknown
}

export interface GithubReviewPayload extends GithubCommentPayload {
  state?: string
  html_url?: string
}

export interface GithubPullRequestPayload {
  number?: number
  state?: "open" | "closed"
  html_url?: string
  head?: { ref?: string; repo?: { full_name?: string } | null }
}

export interface GithubRepositoryPayload {
  owner?: { login?: string }
  name?: string
  full_name?: string
}

/** Fields of a `pull_request_review` delivery. */
export interface GithubReviewDeliveryPayload {
  action?: string
  review?: GithubReviewPayload
  pull_request?: GithubPullRequestPayload
  repository?: GithubRepositoryPayload
}

const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"])

const REVIEW_VERDICTS = new Set<string>(["approved", "changes_requested", "commented"])

export function commentAuthorTrust(comment: GithubCommentPayload): CommentAuthorTrust {
  if (comment.user?.type === "Bot" || comment.performed_via_github_app != null) return "bot"
  return MAINTAINER_ASSOCIATIONS.has(comment.author_association ?? "") ? "maintainer" : "external"
}

/** True for a `pull_request_review` delivery, whatever its action. */
export function isReviewDelivery(raw: GithubReviewDeliveryPayload): boolean {
  return raw.review != null && raw.pull_request != null
}

/**
 * Map a newly submitted review of an open, same-repository pull request to
 * the domain event. Agent Valley names branches `<prefix>/<identifier>`
 * (`workspace/worktree-lifecycle.ts::deriveBranchName`); the orchestrator
 * resolves the identifier against the tracker, so branches people created
 * resolve to no issue. Edits, dismissals, fork branches and closed pull
 * requests are not follow-up work.
 */
export function toReviewEvent(raw: GithubReviewDeliveryPayload): ParsedWebhookEvent | null {
  const { review, pull_request: pr, repository } = raw
  if (raw.action !== "submitted" || !review || !pr) return null
  if (typeof review.id !== "number" || typeof pr.number !== "number" || pr.state !== "open") return null
  const repoName = repository?.full_name
  if (!repoName || pr.head?.repo?.full_name?.toLowerCase() !== repoName.toLowerCase()) return null
  const headBranch = pr.head?.ref ?? ""
  const slash = headBranch.indexOf("/")
  const issueIdentifier = slash > 0 ? headBranch.slice(slash + 1) : ""
  const verdict = (review.state ?? "").toLowerCase()
  if (!issueIdentifier || !REVIEW_VERDICTS.has(verdict)) return null
  const rawBody = review.body ?? ""
  const login = review.user?.login
  return {
    kind: "pull_request.reviewed",
    repository: repoName,
    pullNumber: pr.number,
    headBranch,
    issueIdentifier,
    reviewId: String(review.id),
    reviewer: login ?? "unknown",
    reviewerKeys: login ? [login] : [],
    reviewerTrust: commentAuthorTrust(review),
    verdict: verdict as PullRequestReviewVerdict,
    fromAgentValley: isAgentValleyCommentBody(rawBody),
    body: sanitizeAtBoundary(rawBody),
    url: review.html_url ?? pr.html_url ?? "",
  }
}

const MAX_BOUNDARY_BODY_LENGTH = 64_000
const PROMPT_BOUNDARY_MARKERS = [
  /<\s*\|\s*im_start\s*\|\s*>/gi,
  /<\s*\|\s*im_end\s*\|\s*>/gi,
  /<\s*\|\s*system\s*\|\s*>/gi,
]

/**
 * Boundary-level sanitizer: strip control characters that could break
 * downstream JSON parsing / logs, chop absurdly long bodies, and remove
 * prompt-boundary markers. Deeper injection handling is left to
 * `config/workflow-loader.ts::sanitizeIssueBody` at render time.
 */
export function sanitizeAtBoundary(text: string): string {
  if (!text) return ""
  // Keep \n (\x0A), \r (\x0D), \t (\x09); strip other C0 + DEL.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the intent
  let out = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
  if (out.length > MAX_BOUNDARY_BODY_LENGTH) out = out.slice(0, MAX_BOUNDARY_BODY_LENGTH)
  for (const pattern of PROMPT_BOUNDARY_MARKERS) out = out.replace(pattern, "")
  return out
}
