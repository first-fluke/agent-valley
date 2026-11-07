import { z } from "zod"
import { codeDeliveryPath } from "./code-delivery-contract"

/**
 * Per-cycle product path ceiling shared by the integration receipt and the integration step.
 * Evidence directories grow with every repair attempt, so this guards runaway integration only.
 */
export const MAX_SOURCE_PRODUCT_PATHS = 5_000

const objectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const branch = z.string().min(1).max(200)

export const sourceIntegrationPolicySchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("snapshot-only") }),
  z.strictObject({ mode: z.literal("worktree"), branch, head: objectId }),
])

export const sourceIntegrationSummarySchema = z.strictObject({
  phase: z.enum(["applied", "unchanged"]),
  missionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/),
  branch,
  sourceHead: objectId,
  previousTree: objectId,
  nextTree: objectId,
  patchSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  paths: z.array(z.string().refine(codeDeliveryPath)).max(MAX_SOURCE_PRODUCT_PATHS),
  at: z.iso.datetime(),
})

export type SourceIntegrationPolicy = z.infer<typeof sourceIntegrationPolicySchema>
export type SourceIntegrationSummary = z.infer<typeof sourceIntegrationSummarySchema>
