/**
 * Code host port — the service hosting the repositories Agent Valley
 * delivers to. It need not be the issue tracker: Linear issues are
 * delivered as GitHub pull requests.
 *
 * No imports from outside `domain/`. Validated by scripts/harness/validate.sh.
 */

/** Inline comment attached to a pull request review. */
export interface PullRequestReviewComment {
  path: string
  /** Line in the reviewed file version; null when the host no longer maps it. */
  line: number | null
  body: string
}

export interface CodeHost {
  /** Inline comments of one pull request review. `repository` is `owner/name`. */
  fetchPullRequestReviewComments(
    repository: string,
    pullNumber: number,
    reviewId: string,
  ): Promise<PullRequestReviewComment[]>
}
