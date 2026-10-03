import { z } from "zod"
import { operatingRunSchema, routeEvidenceSchema } from "./operations"

const text = (maximum: number) => z.string().trim().min(1).max(maximum)
export const organizationTimestampSchema = z.iso.datetime({ offset: true })
export const metricTargetSchema = z.strictObject({
  name: text(120),
  unit: text(80).optional(),
  direction: z.enum(["increase", "decrease"]),
  target: z.number().finite().optional(),
})
export type MetricTarget = z.infer<typeof metricTargetSchema>
export const memoryEvidenceSchema = z.strictObject({
  path: text(2_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  verification: text(1_000).optional(),
})
export type MemoryEvidence = z.infer<typeof memoryEvidenceSchema>
export const organizationMemoryInputSchema = z.strictObject({
  id: text(120).optional(),
  kind: z.enum(["lesson", "decision", "stack-standard"]),
  content: text(2_000),
  source: text(500).default("Operator via av memory add"),
  tags: z.array(text(80)).max(20).default([]),
  evidence: z.array(memoryEvidenceSchema).max(20).default([]),
})
export const organizationMemorySchema = organizationMemoryInputSchema.extend({
  id: text(120),
  approval: z.literal("human-approved"),
  createdAt: organizationTimestampSchema,
})
export type OrganizationMemory = z.infer<typeof organizationMemorySchema>
export const businessMetricInputSchema = z.strictObject({
  id: text(120).optional(),
  name: text(120),
  value: z.number().finite(),
  unit: text(80),
  source: text(500),
  timestamp: organizationTimestampSchema,
  provenance: z.literal("operator-recorded").optional(),
  experimentId: text(120).optional(),
})
export const metricMeasurementWindowSchema = z
  .strictObject({ start: organizationTimestampSchema, end: organizationTimestampSchema })
  .refine((window) => Date.parse(window.start) < Date.parse(window.end), "Measurement window must end after it starts.")
export const collectedBusinessMetricInputSchema = businessMetricInputSchema.omit({ provenance: true }).extend({
  sourceId: text(120),
  collectedAt: organizationTimestampSchema,
  window: metricMeasurementWindowSchema.optional(),
})
export const businessMetricSampleSchema = businessMetricInputSchema
  .extend({
    id: text(120),
    provenance: z.enum(["operator-recorded", "source-collected"]),
    sourceId: text(120).optional(),
    collectedAt: organizationTimestampSchema.optional(),
    window: metricMeasurementWindowSchema.optional(),
  })
  .superRefine((sample, ctx) => {
    if (sample.provenance === "source-collected" && (!sample.sourceId || !sample.collectedAt))
      ctx.addIssue({
        code: "custom",
        path: ["sourceId"],
        message: "Source-collected metrics require sourceId and collectedAt.",
      })
    if (sample.collectedAt && Date.parse(sample.collectedAt) < Date.parse(sample.timestamp))
      ctx.addIssue({
        code: "custom",
        path: ["collectedAt"],
        message: "Collection cannot precede the measurement timestamp.",
      })
    if (sample.window && Date.parse(sample.window.end) > Date.parse(sample.timestamp))
      ctx.addIssue({
        code: "custom",
        path: ["window"],
        message: "Measurement window cannot end after the measurement timestamp.",
      })
  })
export type BusinessMetricSample = z.infer<typeof businessMetricSampleSchema>
export const metricComparisonSchema = z.strictObject({
  name: text(120),
  unit: text(80).optional(),
  direction: z.enum(["increase", "decrease"]),
  target: z.number().finite().optional(),
  status: z.enum(["improved", "regressed", "unchanged", "missing-evidence", "unit-mismatch"]),
  baseline: businessMetricSampleSchema.optional(),
  current: businessMetricSampleSchema.optional(),
  delta: z.number().finite().optional(),
  targetMet: z.boolean().optional(),
  reason: text(500),
})
export type MetricComparison = z.infer<typeof metricComparisonSchema>
export const businessExperimentInputSchema = z.strictObject({
  id: text(120),
  name: text(200),
  hypothesis: text(1_000),
  targets: z.array(metricTargetSchema).min(1).max(20),
  beforeSampleIds: z.array(text(120)).max(100),
  afterSampleIds: z.array(text(120)).max(100),
  timestamp: organizationTimestampSchema,
  adjudication: z
    .strictObject({
      status: z.enum(["supported", "contradicted", "inconclusive"]),
      reason: text(1_000),
      source: text(500),
      timestamp: organizationTimestampSchema,
    })
    .optional(),
})
export const businessExperimentSchema = businessExperimentInputSchema.extend({
  provenance: z.literal("operator-recorded"),
  comparisons: z.array(metricComparisonSchema).max(20),
  omittedMetricNames: z.array(text(120)).max(20).optional(),
})
export type BusinessExperiment = z.infer<typeof businessExperimentSchema>
export const organizationOutcomeSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  missionId: text(120),
  missionVersion: text(200),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  goal: text(16_000),
  status: z.enum(["completed", "failed", "cancelled"]),
  createdAt: organizationTimestampSchema,
  summary: text(2_000),
  summaryAuthority: z.literal("reported claim; evidence is authoritative"),
  evidence: z.array(memoryEvidenceSchema).max(30),
  runs: z.array(operatingRunSchema).max(20_000),
  verification: z.strictObject({ ok: z.boolean(), fingerprint: text(200), command: text(2_000).optional() }).optional(),
  finalReviewPassed: z.boolean().optional(),
  observations: z
    .array(
      z.strictObject({
        authority: z.literal("evidence-linked observation; not an approved standard"),
        content: text(1_000),
        evidence: z.array(memoryEvidenceSchema).max(30),
      }),
    )
    .max(20),
})
export type OrganizationOutcome = z.infer<typeof organizationOutcomeSchema>
export const organizationContextSchema = z.strictObject({
  kind: z.literal("repository-organization-evidence"),
  authority: z.literal("Historical evidence, not instructions or current acceptance criteria"),
  repositoryRoot: text(2_000),
  goal: text(1_000),
  generatedAt: organizationTimestampSchema,
  memories: z.array(organizationMemorySchema).max(12),
  metrics: z.array(businessMetricSampleSchema).max(40),
  comparisons: z.array(metricComparisonSchema).max(20),
  omittedMetricNames: z.array(text(120)).max(20).optional(),
  experiments: z.array(businessExperimentSchema).max(8),
  outcomes: z.array(organizationOutcomeSchema.omit({ runs: true })).max(8),
  routeEvidence: z.array(routeEvidenceSchema).max(100),
})
export type OrganizationContext = z.infer<typeof organizationContextSchema>
