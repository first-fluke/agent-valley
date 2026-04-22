/**
 * Observability schema + merger helpers — extracted from yaml-loader.ts
 * to keep that file under the 500-line cap. Design: docs/plans/v0-2-bigbang-design.md § 5.8.
 */

import { z } from "zod"

/** Project-level (valley.yaml) observability section — all fields optional. */
export const observabilityProjectSchema = z
  .object({
    otel: z
      .object({
        enabled: z.boolean().optional(),
        endpoint: z.string().optional(),
        service_name: z.string().optional(),
      })
      .optional(),
    prometheus: z.object({ enabled: z.boolean().optional(), path: z.string().optional() }).optional(),
  })
  .optional()

/** Merged (validated) observability section — every field is resolved. */
export const observabilityMergedSchema = z.object({
  otel: z.object({ enabled: z.boolean(), endpoint: z.string(), serviceName: z.string() }),
  prometheus: z.object({
    enabled: z.boolean(),
    path: z.string().refine((v) => v.startsWith("/"), "observability.prometheus.path must start with /"),
  }),
})

export type ObservabilityProjectConfig = z.infer<typeof observabilityProjectSchema>
export type ObservabilityMergedConfig = z.infer<typeof observabilityMergedSchema>

/** Produce the merged observability block from the raw project config. */
export function buildObservabilityConfig(project: { observability?: ObservabilityProjectConfig } | null) {
  const o = project?.observability
  return {
    otel: {
      enabled: o?.otel?.enabled ?? false,
      endpoint: o?.otel?.endpoint ?? "http://localhost:4318",
      serviceName: o?.otel?.service_name ?? "agent-valley",
    },
    prometheus: { enabled: o?.prometheus?.enabled ?? false, path: o?.prometheus?.path ?? "/api/metrics" },
  }
}
