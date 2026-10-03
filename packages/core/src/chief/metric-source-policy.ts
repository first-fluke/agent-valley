import { z } from "zod"
import {
  businessMetricSampleSchema,
  metricMeasurementWindowSchema,
  organizationTimestampSchema,
} from "./organization-types"

const text = (limit: number) => z.string().trim().min(1).max(limit)
const envName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use an environment variable name, not a credential or URL.")
const jsonPath = text(500).refine(
  (path) =>
    path
      .split(".")
      .every((part) => /^[A-Za-z0-9_-]+$/.test(part) && !["__proto__", "constructor", "prototype"].includes(part)),
  "Use dot-separated JSON keys or array indexes; prototype keys are forbidden.",
)
export const metricSourceSchema = z
  .strictObject({
    id: text(120),
    name: text(120),
    unit: text(80),
    adapter: text(80).default("http-json"),
    url_env: envName.optional(),
    token_env: envName.optional(),
    file: text(2_000).optional(),
    value_path: jsonPath.default("value"),
    timestamp_path: jsonPath.default("timestamp"),
    unit_path: jsonPath.default("unit"),
    window_start_path: jsonPath.optional(),
    window_end_path: jsonPath.optional(),
    max_age_ms: z.number().int().min(1_000).max(604_800_000).default(300_000),
    poll_interval_ms: z.number().int().min(1_000).max(86_400_000).default(60_000),
    timeout_ms: z.number().int().min(100).max(60_000).default(10_000),
    currency: z.enum(["USD", "EUR", "GBP", "AUD", "CAD"]).default("USD"),
    window_ms: z.number().int().min(1_000).max(31_536_000_000).default(86_400_000),
  })
  .superRefine((source, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message })
    if (source.adapter === "http-json" && !source.url_env)
      issue("url_env", "Set chief.metric_sources.sources[].url_env in av.yaml.")
    if (source.adapter === "json-file" && !source.file)
      issue("file", "Set a repository-relative JSON file in chief.metric_sources.sources[].file.")
    if (source.adapter === "stripe-revenue" && (!source.token_env || source.unit !== source.currency))
      issue(
        "token_env",
        "Set token_env and use the selected currency as unit for Stripe captured charge revenue less refunds.",
      )
    if (!!source.window_start_path !== !!source.window_end_path)
      issue("window_start_path", "Set both measurement window paths or omit both.")
  })
export type MetricSource = z.output<typeof metricSourceSchema>
export const metricSourcePolicySchema = z
  .strictObject({
    sources: z.array(metricSourceSchema).min(1).max(20),
    observation_window_ms: z.number().int().min(0).max(604_800_000).default(60_000),
    max_observation_ms: z.number().int().min(1_000).max(2_592_000_000).default(259_200_000),
  })
  .superRefine((policy, ctx) => {
    if (new Set(policy.sources.map((source) => source.id)).size !== policy.sources.length)
      ctx.addIssue({ code: "custom", path: ["sources"], message: "Metric source IDs must be unique." })
    if (new Set(policy.sources.map((source) => source.name)).size !== policy.sources.length)
      ctx.addIssue({
        code: "custom",
        path: ["sources"],
        message: "Configure one authoritative source per metric name.",
      })
    if (policy.observation_window_ms > policy.max_observation_ms)
      ctx.addIssue({
        code: "custom",
        path: ["observation_window_ms"],
        message: "Observation window must fit inside max_observation_ms.",
      })
  })
export type MetricSourcePolicy = z.output<typeof metricSourcePolicySchema>
export const sourceMetricObservationSchema = z.strictObject({
  value: z.number().finite(),
  unit: text(80),
  timestamp: organizationTimestampSchema,
  window: metricMeasurementWindowSchema.optional(),
})
export type SourceMetricObservation = z.output<typeof sourceMetricObservationSchema>
export interface MetricSourceRequest {
  source: MetricSource
  repositoryRoot: string
  now: number
  signal: AbortSignal
  fetch: typeof globalThis.fetch
  env: Readonly<Record<string, string | undefined>>
}
export interface MetricSourceAdapter {
  collect(request: MetricSourceRequest): Promise<SourceMetricObservation>
}
export type MetricSourceRegistry = ReadonlyMap<string, MetricSourceAdapter>
export const metricSourceCollectionSchema = z.strictObject({
  collectedAt: organizationTimestampSchema,
  nextPollAt: organizationTimestampSchema,
  results: z
    .array(
      z.strictObject({
        sourceId: text(120),
        name: text(120),
        status: z.enum(["collected", "unchanged", "unavailable", "failed"]),
        sample: businessMetricSampleSchema.optional(),
        reason: text(1_000).optional(),
      }),
    )
    .max(20),
})
export type MetricSourceCollection = z.output<typeof metricSourceCollectionSchema>
export class MetricSourceError extends Error {
  constructor(
    message: string,
    readonly unavailable = false,
  ) {
    super(message)
    this.name = "MetricSourceError"
  }
}
