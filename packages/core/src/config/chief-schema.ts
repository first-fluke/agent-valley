import { z } from "zod"
import { type CapturePolicy, capturePolicySchema } from "../chief/capture-schema"
import { containerObservationPolicySchema } from "../chief/container-observation-policy"
import { type ExecutionPolicy, executionPolicySchema } from "../chief/execution"
import { metricSourcePolicySchema } from "../chief/metric-source-policy"
import { type ChiefOperatingPolicy, chiefOperatingPolicySchema } from "../chief/operations"
import { metricTargetSchema } from "../chief/organization-types"
import { reportDeliveryPolicySchema } from "../chief/report-delivery-contract"
import { toolEnvKeysSchema } from "../chief/tool-environment"

const price = z.number().finite().nonnegative().optional()
export const chiefConfigSchema = z.strictObject({
  container_observation: containerObservationPolicySchema.optional(),
  tool_env_keys: toolEnvKeysSchema.optional(),
  execution: z
    .strictObject({
      max_parallel: z.number().int().min(1).max(8).default(3),
      max_duration_sec: z.number().int().min(1).max(604_800).default(86_400),
      max_runs: z.number().int().min(1).max(2_000).default(200),
      max_estimated_cost_usd: z.number().finite().positive().optional(),
      max_retries: z.number().int().min(0).max(10).default(3),
      retry_delay_ms: z.number().int().min(10).max(300_000).default(1_000),
      auto_resume: z.boolean().default(true),
    })
    .optional(),
  metric_sources: metricSourcePolicySchema.optional(),
  routing: z
    .strictObject({
      candidates: z
        .array(
          z.strictObject({
            actor_type: z.string().min(1).max(128),
            model: z.string().min(1).max(256).optional(),
            input_per_million_usd: price,
            output_per_million_usd: price,
          }),
        )
        .min(1)
        .max(20),
      min_samples: z.number().int().min(1).max(1_000).default(3),
      min_success_rate: z.number().min(0).max(1).default(0.8),
    })
    .optional(),
  review_vendor: z.enum(["prefer", "require", "off"]).optional(),
  memory: z.boolean().optional(),
  metric_targets: z.array(metricTargetSchema).max(20).optional(),
  reporting: reportDeliveryPolicySchema.optional(),
  capture: z
    .strictObject({
      enabled: z.boolean().default(false),
      target_url: z.url().optional(),
      tab_id: z.string().min(1).max(200).optional(),
      interval_ms: z.number().int().min(500).max(60_000).default(2_000),
      max_frames: z.number().int().min(1).max(300).default(60),
      timeout_ms: z.number().int().min(1_000).max(60_000).default(15_000),
      video: z.boolean().default(true),
    })
    .superRefine((capture, ctx) => {
      if (capture.enabled && !capture.target_url && !capture.tab_id)
        ctx.addIssue({
          code: "custom",
          path: ["target_url"],
          message: "Set chief.capture.target_url or tab_id to an intended browser tab.",
        })
      if (capture.target_url && !/^https?:/.test(capture.target_url))
        ctx.addIssue({ code: "custom", path: ["target_url"], message: "Use an HTTP(S) browser URL." })
    })
    .optional(),
})
export type ChiefConfig = z.infer<typeof chiefConfigSchema>
export function mergeChiefConfig(global?: ChiefConfig, project?: ChiefConfig): ChiefConfig {
  return chiefConfigSchema.parse({ ...global, ...project })
}
export function chiefExecutionPolicy(config: ChiefConfig): ExecutionPolicy {
  const execution = config.execution
  return executionPolicySchema.parse(
    execution
      ? {
          maxParallel: execution.max_parallel,
          maxDurationSec: execution.max_duration_sec,
          maxRuns: execution.max_runs,
          maxEstimatedCostUsd: execution.max_estimated_cost_usd,
          maxRetries: execution.max_retries,
          retryDelayMs: execution.retry_delay_ms,
          autoResume: execution.auto_resume,
        }
      : {},
  )
}
export function chiefOperatingPolicy(
  config: ChiefConfig,
  readyActors: string[],
  automatic = true,
): ChiefOperatingPolicy {
  return chiefOperatingPolicySchema.parse({
    routing: config.routing
      ? {
          candidates: config.routing.candidates.map((item) => ({
            actorType: item.actor_type,
            model: item.model,
            inputPerMillionUsd: item.input_per_million_usd,
            outputPerMillionUsd: item.output_per_million_usd,
          })),
          minSamples: config.routing.min_samples,
          minSuccessRate: config.routing.min_success_rate,
        }
      : automatic && readyActors.length > 1
        ? { candidates: readyActors.map((actorType) => ({ actorType })), minSamples: 3, minSuccessRate: 0.8 }
        : undefined,
    reviewVendor: config.review_vendor ?? "prefer",
    memory: config.memory ?? true,
    metricTargets: config.metric_targets,
    readyActors,
  })
}
export function chiefCapturePolicy(config: ChiefConfig): CapturePolicy | undefined {
  if (!config.capture) return undefined
  const capture = config.capture
  return capturePolicySchema.parse({
    enabled: capture.enabled,
    targetUrl: capture.target_url,
    tabId: capture.tab_id,
    intervalMs: capture.interval_ms,
    maxFrames: capture.max_frames,
    timeoutMs: capture.timeout_ms,
    video: capture.video,
  })
}
