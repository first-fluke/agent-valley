/**
 * Comment relay schema — which tracker comments reach the actor working on
 * an issue. `linear.comment_relay` and `github.comment_relay` share this
 * shape; the active tracker's block is merged into the top-level
 * `commentRelay`.
 *
 * Pure Zod + type definitions. No I/O.
 */

import { z } from "zod"

export const commentRelayProjectSchema = z.object({
  enabled: z.boolean().optional(),
  /** Authors whose comments are never relayed: GitHub logins; Linear emails, user ids or names. */
  ignore_authors: z.array(z.string().min(1)).optional(),
})

export const commentRelayMergedSchema = z
  .object({
    enabled: z.boolean(),
    ignoreAuthors: z.array(z.string()),
  })
  .optional()

export function buildCommentRelayConfig(
  relay: z.infer<typeof commentRelayProjectSchema> | undefined,
): NonNullable<z.infer<typeof commentRelayMergedSchema>> {
  return { enabled: relay?.enabled ?? false, ignoreAuthors: relay?.ignore_authors ?? [] }
}
