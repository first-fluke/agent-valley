import { z } from "zod"
import type { MetricTarget } from "./organization"

const actorType = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/)
const text = z.string().trim().min(1).max(2_000)
const amount = z.number().finite().nonnegative()

export const routingCandidateSchema = z.strictObject({
  actorType,
  model: text.optional(),
  inputPerMillionUsd: amount.optional(),
  outputPerMillionUsd: amount.optional(),
})
export type RoutingCandidate = z.infer<typeof routingCandidateSchema>

export interface ChiefOperatingPolicy {
  routing?: { candidates: RoutingCandidate[]; minSamples: number; minSuccessRate: number }
  reviewVendor: "prefer" | "require" | "off"
  readyActors?: string[]
  memory: boolean
  metricTargets?: MetricTarget[]
}

export const chiefOperatingPolicySchema = z.strictObject({
  routing: z
    .strictObject({
      candidates: z.array(routingCandidateSchema).min(1).max(20),
      minSamples: z.number().int().min(1).max(1_000),
      minSuccessRate: z.number().min(0).max(1),
    })
    .optional(),
  reviewVendor: z.enum(["prefer", "require", "off"]),
  readyActors: z.array(actorType).max(20).optional(),
  memory: z.boolean(),
  metricTargets: z
    .array(
      z.strictObject({
        name: text,
        unit: text.optional(),
        direction: z.enum(["increase", "decrease"]),
        target: z.number().finite().optional(),
      }),
    )
    .max(20)
    .optional(),
})

export const operatingRunSchema = z.strictObject({
  runId: text,
  taskId: text.optional(),
  stage: z.enum([
    "plan",
    "technical-review",
    "design-review",
    "marketing-review",
    "work",
    "review",
    "final-review",
    "supervise",
    "report",
  ]),
  actorId: text,
  actorType,
  model: text.optional(),
  actualModel: text.optional(),
  startedAt: text,
  finishedAt: text.nullable(),
  elapsedMs: amount.nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  costUsd: amount.nullable(),
  outcome: z.enum(["pending", "passed", "rejected", "failed"]),
  routingReason: text.optional(),
  evidence: text.optional(),
  fingerprint: text.optional(),
})
export type OperatingRun = z.infer<typeof operatingRunSchema>
export type OperationRun = OperatingRun

export const routeEvidenceSchema = z
  .strictObject({
    actorType,
    model: text.optional(),
    samples: z.number().int().nonnegative(),
    successes: z.number().int().nonnegative(),
    totalCostUsd: amount.nullable(),
    successfulDeliverableCostUsd: amount.nullable(),
  })
  .refine((entry) => entry.successes <= entry.samples, "Route successes cannot exceed actual samples.")
export type RouteEvidence = z.infer<typeof routeEvidenceSchema>

export const reviewDecisionSchema = z.strictObject({
  taskId: text,
  runId: text.optional(),
  workerActorType: actorType,
  reviewerId: text,
  reviewerActorType: actorType,
  crossVendor: z.boolean(),
  outcome: z.enum(["assigned", "passed", "rejected", "failed"]).optional(),
  reason: text,
})
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>

export const chiefOperationsSchema = z.strictObject({
  runs: z.array(operatingRunSchema).max(20_000),
  routingEvidence: z.array(routeEvidenceSchema).max(100),
  reviewDecisions: z.array(reviewDecisionSchema).max(10_000),
})
export type ChiefOperations = z.infer<typeof chiefOperationsSchema>
