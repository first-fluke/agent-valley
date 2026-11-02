/**
 * Comment relay schema — which tracker comments and pull request reviews
 * reach the actor working on an issue.
 *
 * `linear.comment_relay` and `github.comment_relay` share the base shape;
 * only GitHub can report pull request reviews, so `pull_request_reviews`
 * exists on the GitHub block alone. The active tracker's block is merged
 * into the top-level `commentRelay`.
 *
 * Pure Zod + type definitions. No I/O.
 */

import { z } from "zod"

export const commentRelayProjectSchema = z.object({
  enabled: z.boolean().optional(),
  /** Authors whose comments are never relayed: GitHub logins; Linear emails, user ids or names. */
  ignore_authors: z.array(z.string().min(1)).optional(),
})

export const githubCommentRelayProjectSchema = commentRelayProjectSchema.extend({
  /** Also turn submitted reviews of Agent Valley pull requests into follow-up work. Requires `enabled`. */
  pull_request_reviews: z.boolean().optional(),
})

export const commentRelayMergedSchema = z
  .object({
    enabled: z.boolean(),
    ignoreAuthors: z.array(z.string()),
    pullRequestReviews: z.boolean(),
  })
  .optional()

export function buildCommentRelayConfig(
  relay: z.infer<typeof githubCommentRelayProjectSchema> | undefined,
): NonNullable<z.infer<typeof commentRelayMergedSchema>> {
  return {
    enabled: relay?.enabled ?? false,
    ignoreAuthors: relay?.ignore_authors ?? [],
    pullRequestReviews: relay?.pull_request_reviews ?? false,
  }
}
