import { z } from "zod"

const objectId = z.string().regex(/^[a-f0-9]{40,64}$/)
const imageSchema = z.strictObject({ mode: z.enum(["100644", "100755", "120000"]), oid: objectId })
export const parallelBaselineSchema = z.strictObject({ head: objectId, tree: objectId })
export type ParallelBaseline = z.infer<typeof parallelBaselineSchema>
export const parallelWorkspaceSchema = z.strictObject({
  version: z.literal(1),
  missionId: z.string().min(1).max(200),
  taskId: z.string().min(1).max(200),
  attempt: z.number().int().min(1),
  sourceWorkspacePath: z.string().min(1),
  path: z.string().min(1),
  branch: z.string().min(1),
  baselineHead: objectId,
  baselineTree: objectId,
})
export type ParallelTaskWorkspace = z.infer<typeof parallelWorkspaceSchema>
export const taskWorktreeRecordSchema = parallelWorkspaceSchema
export type TaskWorktreeRecord = ParallelTaskWorkspace
export const parallelDeliverySchema = z.strictObject({
  version: z.literal(1),
  workspace: parallelWorkspaceSchema,
  patchPath: z.string().min(1),
  patchSha256: z.string().regex(/^[a-f0-9]{64}$/),
  deliveryTree: objectId,
  changes: z
    .array(z.strictObject({ path: z.string().min(1), before: imageSchema.nullable(), after: imageSchema.nullable() }))
    .max(20_000),
  status: z.enum(["prepared", "applying", "applied"]),
})
export type ParallelDelivery = z.infer<typeof parallelDeliverySchema>
export class ParallelIntegrationConflict extends Error {
  constructor(
    readonly taskId: string,
    readonly paths: string[],
    detail = "The shared worktree changed the same files.",
  ) {
    super(
      `${detail} Task ${taskId}: ${paths.join(", ")}. Its isolated Actor edits were retained; inspect them before Chief recovery.`,
    )
  }
}
