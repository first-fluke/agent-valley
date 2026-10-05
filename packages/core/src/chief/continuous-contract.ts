import { z } from "zod"
import { containerObservationPolicySchema, containerObservationSnapshotSchema } from "./container-observation-policy"
import { validateContainerObservation } from "./container-observation-state"

export const operationIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/)
const pathSchema = z.string().min(1).max(4096)
const timestampSchema = z.iso.datetime()
const objectIdSchema = z.string().regex(/^[a-f0-9]{40,64}$/)

export const continuousDecisionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("execute"),
    goal: z.string().trim().min(1).max(32_000),
    reason: z.string().trim().min(1).max(8000),
    evidence: z.array(z.string().trim().min(1).max(4000)).min(1).max(40),
  }),
  z.strictObject({ action: z.literal("wait"), reason: z.string().trim().min(1).max(8000) }),
])
export type ContinuousDecision = z.infer<typeof continuousDecisionSchema>

export function parseContinuousDecision(output: string): ContinuousDecision {
  try {
    if (output.length > 256_000) throw new Error("Decision output exceeds its limit")
    return continuousDecisionSchema.parse(JSON.parse(output))
  } catch {
    throw new Error(
      'Invalid Chief decision. Return only strict JSON: {"action":"execute","goal":"…","reason":"…","evidence":["source/window"]} or {"action":"wait","reason":"…"}; keep it below 256000 characters.',
    )
  }
}

export const continuousBaselineSchema = z.strictObject({
  version: z.literal(1),
  operationId: operationIdSchema,
  repositoryRoot: pathSchema,
  sourceWorkspacePath: pathSchema,
  missionId: operationIdSchema.optional(),
  path: pathSchema,
  branch: z.string().min(1).max(200),
  baselineHead: objectIdSchema,
  baselineTree: objectIdSchema,
  commit: objectIdSchema,
  verifiedFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
})
export type ContinuousBaseline = z.infer<typeof continuousBaselineSchema>

const historyEntrySchema = z.strictObject({
  missionId: operationIdSchema,
  goal: z.string().min(1).max(32_000),
  reason: z.string().min(1).max(8000),
  evidence: z.array(z.string().min(1).max(4000)).max(40),
  completedAt: timestampSchema,
  baselinePath: pathSchema,
})
export const operationSchema = z
  .strictObject({
    id: operationIdSchema,
    repositoryRoot: pathSchema,
    charter: z.string().trim().min(1).max(32_000),
    settings: z.record(z.string().min(1).max(80), z.union([z.string().max(32_000), z.boolean()])),
    phase: z.enum(["deciding", "running", "accepting", "waiting", "paused", "completed"]),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    completedCycles: z.number().int().min(0),
    cycleLimit: z.number().int().min(1).max(1_000_000).optional(),
    waitIntervalSec: z.number().int().min(1).max(86_400),
    containerObservationPolicy: containerObservationPolicySchema.optional(),
    containerObservation: containerObservationSnapshotSchema.optional(),
    containerObservationRevision: z.number().int().min(1).optional(),
    decisionObservation: containerObservationSnapshotSchema.optional(),
    decisionObservationRevision: z.number().int().min(1).optional(),
    baseline: continuousBaselineSchema.optional(),
    currentMissionId: operationIdSchema.optional(),
    decisionId: operationIdSchema.optional(),
    decision: continuousDecisionSchema.optional(),
    lastDecisionKey: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    nextRunAt: timestampSchema.optional(),
    resumePhase: z.enum(["deciding", "running", "accepting", "waiting"]).optional(),
    error: z.string().max(16_000).optional(),
    history: z.array(historyEntrySchema).max(20),
  })
  .superRefine((operation, context) => {
    if (
      (operation.containerObservationRevision && !operation.containerObservation) ||
      (operation.decisionObservationRevision &&
        (!operation.decisionObservation ||
          operation.decisionObservationRevision > (operation.containerObservationRevision ?? 0)))
    )
      context.addIssue({
        code: "custom",
        path: ["containerObservationRevision"],
        message: "Observation revisions require their saved evidence and cannot exceed the latest transition.",
      })
    for (const key of ["containerObservation", "decisionObservation"] as const) {
      if (!operation[key]) continue
      try {
        validateContainerObservation(operation.containerObservationPolicy, operation[key])
      } catch (error) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (
      operation.baseline &&
      (operation.baseline.operationId !== operation.id ||
        operation.baseline.repositoryRoot !== operation.repositoryRoot)
    )
      context.addIssue({
        code: "custom",
        message: "Operation baseline belongs to a different operation or repository.",
        path: ["baseline"],
      })
    if (
      (operation.phase === "running" || operation.phase === "accepting") &&
      (!operation.currentMissionId || operation.decision?.action !== "execute")
    )
      context.addIssue({
        code: "custom",
        message: "An active operation requires its saved child ID and execution decision.",
        path: ["currentMissionId"],
      })
    if (operation.phase === "waiting" && !operation.nextRunAt)
      context.addIssue({
        code: "custom",
        message: "A waiting operation requires its next decision timestamp.",
        path: ["nextRunAt"],
      })
    if (operation.currentMissionId && operation.decision?.action !== "execute")
      context.addIssue({
        code: "custom",
        message: "A saved child requires its original execution decision.",
        path: ["decision"],
      })
  })
export type Operation = z.infer<typeof operationSchema>
export type ContinuousOperation = Operation
