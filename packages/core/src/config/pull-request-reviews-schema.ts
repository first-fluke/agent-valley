/**
 * Pull request review follow-up schema — `delivery.pull_request_reviews`.
 *
 * Reviews arrive from the code host (GitHub), which need not be the issue
 * tracker. With the GitHub tracker the same webhook carries reviews and
 * `github.webhook_secret` verifies them; with Linear, a separate GitHub
 * webhook needs its own `webhook_secret`.
 *
 * Pure Zod + type definitions. No I/O.
 */

import { z } from "zod"

export const pullRequestReviewsProjectSchema = z.object({
  enabled: z.boolean().optional(),
  /** Signing secret of the GitHub webhook sending "Pull request reviews". Linear tracker only. */
  webhook_secret: z.string().min(1).optional(),
  /** GitHub logins whose reviews never become follow-up work. */
  ignore_authors: z.array(z.string().min(1)).optional(),
})

export const pullRequestReviewsMergedSchema = z
  .object({
    enabled: z.boolean(),
    webhookSecret: z.string(),
    ignoreAuthors: z.array(z.string()),
  })
  .refine((reviews) => !reviews.enabled || reviews.webhookSecret, {
    path: ["webhookSecret"],
    message:
      "Pull request review follow-up needs the GitHub webhook secret.\n" +
      "  Fix: set delivery.pull_request_reviews.webhook_secret in av.yaml (github.webhook_secret with the GitHub tracker).",
  })
  .optional()

export function buildPullRequestReviewsConfig(
  reviews: z.infer<typeof pullRequestReviewsProjectSchema> | undefined,
  trackerKind: "linear" | "github",
  githubWebhookSecret: string | undefined,
): NonNullable<z.infer<typeof pullRequestReviewsMergedSchema>> {
  return {
    enabled: reviews?.enabled ?? false,
    // The GitHub tracker's receiver verifies reviews on its own endpoint.
    webhookSecret: (trackerKind === "github" ? githubWebhookSecret : reviews?.webhook_secret) ?? "",
    ignoreAuthors: reviews?.ignore_authors ?? [],
  }
}
