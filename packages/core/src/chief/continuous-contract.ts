import { z } from "zod"
import { containerObservationPolicySchema, containerObservationSnapshotSchema } from "./container-observation-policy"
import { validateContainerObservation } from "./container-observation-state"
import { providerHealthEvidenceSchema } from "./operations"
import { parseJson } from "./plan-validation"
import { sourceIntegrationPolicySchema, sourceIntegrationSummarySchema } from "./source-integration-contract"

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
    return continuousDecisionSchema.parse(parseJson(output, "Chief decision", 256_000))
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
  sourceIntegration: sourceIntegrationSummarySchema.optional(),
})
/**
 * Operator-only charter corrections. The original charter stays immutable so saved decision
 * checkpoints keep their identity and the audit trail keeps the instruction each cycle ran under.
 */
export const charterAmendmentSchema = z.strictObject({
  id: z.number().int().min(1).max(50),
  at: timestampSchema,
  text: z.string().trim().min(1).max(8_000),
  supersedes: z.array(z.number().int().min(1).max(50)).max(50).optional(),
})
export type CharterAmendment = z.infer<typeof charterAmendmentSchema>

export const charterAmendmentsSchema = z
  .array(charterAmendmentSchema)
  .max(50)
  .superRefine((amendments, context) => {
    for (const [index, entry] of amendments.entries()) {
      if (entry.id !== index + 1)
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message:
            "Charter amendment IDs stay sequential from 1 in recorded order. Append with av order --resume <operation-id> --charter-append.",
        })
      for (const target of entry.supersedes ?? [])
        if (target >= entry.id)
          context.addIssue({
            code: "custom",
            path: [index, "supersedes"],
            message: "A charter amendment can only supersede an earlier recorded amendment ID.",
          })
    }
    if (amendments.reduce((total, entry) => total + entry.text.length, 0) > 32_000)
      context.addIssue({
        code: "custom",
        message:
          "Charter amendments exceed their 32000 character budget. Start a new order with a corrected charter instead of extending this one.",
      })
  })

/** Superseded entries stay in the record for audit but no longer instruct the Chief. */
export function activeCharterAmendments(operation: ContinuousOperation): CharterAmendment[] {
  const amendments = operation.charterAmendments ?? []
  const superseded = new Set(amendments.flatMap((entry) => entry.supersedes ?? []))
  return amendments.filter((entry) => !superseded.has(entry.id))
}

/** Resume-only operator input. Actor output, reports and organization memory never reach this path. */
export function nextCharterAmendments(
  operation: ContinuousOperation,
  input: { text: string; supersedes?: number[] },
  at: string,
): CharterAmendment[] {
  const amendments = operation.charterAmendments ?? []
  const supersedes = input.supersedes?.length ? [...new Set(input.supersedes)].sort((a, b) => a - b) : undefined
  const known = new Set(amendments.map((entry) => entry.id))
  for (const id of supersedes ?? [])
    if (!known.has(id))
      throw new Error(
        `Charter amendment ${id} is not recorded. Inspect av operations --report <operation-id> for its amendment IDs.`,
      )
  return charterAmendmentsSchema.parse([
    ...amendments,
    { id: amendments.length + 1, at, text: input.text, ...(supersedes ? { supersedes } : {}) },
  ])
}

export const operationSchema = z
  .strictObject({
    id: operationIdSchema,
    repositoryRoot: pathSchema,
    charter: z.string().trim().min(1).max(32_000),
    charterAmendments: charterAmendmentsSchema.optional(),
    settings: z.record(z.string().min(1).max(80), z.union([z.string().max(32_000), z.boolean()])),
    actorHealth: z.array(providerHealthEvidenceSchema).max(100).optional(),
    phase: z.enum(["deciding", "running", "accepting", "waiting", "paused", "completed"]),
    pauseKind: z.enum(["interrupted", "blocked", "service-shutdown"]).optional(),
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
    sourceIntegrationPolicy: sourceIntegrationPolicySchema.optional(),
    sourceIntegration: sourceIntegrationSummarySchema.optional(),
    currentMissionId: operationIdSchema.optional(),
    decisionId: operationIdSchema.optional(),
    decision: continuousDecisionSchema.optional(),
    lastDecisionKey: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    nextRunAt: timestampSchema.optional(),
    recovery: z
      .strictObject({
        target: z.enum(["child", "decision"]),
        checkpointId: operationIdSchema,
        attempts: z.number().int().min(0).max(2000),
        failedAttempts: z.number().int().min(0).max(2000).optional(),
        waitContinuationKey: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        disposition: z.enum(["retrying", "waiting", "unresolved", "protected"]),
        reason: z.string().max(16_000),
        nextRunAt: timestampSchema.optional(),
      })
      .optional(),
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
    if (
      operation.recovery &&
      operation.recovery.checkpointId !==
        (operation.recovery.target === "child" ? operation.currentMissionId : operation.decisionId)
    )
      context.addIssue({
        code: "custom",
        path: ["recovery"],
        message: "Recovery must retain the original child or decision checkpoint identity.",
      })
  })
export type Operation = z.infer<typeof operationSchema>
export type ContinuousOperation = Operation
