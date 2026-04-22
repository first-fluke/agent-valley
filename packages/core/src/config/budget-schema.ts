/**
 * Budget schema + merger helpers — extracted from yaml-loader.ts to keep
 * that file under the 500-line cap.
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 4.5 / § 5.5.
 */

import { z } from "zod"

/** Project-level (valley.yaml) budget section — every field optional. */
export const budgetProjectSchema = z
  .object({
    per_issue: z
      .object({
        tokens: z.number().min(0).optional(),
        usd: z.number().min(0).optional(),
      })
      .optional(),
    per_day: z
      .object({
        tokens: z.number().min(0).optional(),
        usd: z.number().min(0).optional(),
      })
      .optional(),
    on_exceed: z.enum(["block", "warn"]).optional(),
    allow_override_label: z.boolean().optional(),
    pricing: z
      .record(
        z.string().min(1),
        z.object({
          input_per_mtok: z.number().min(0),
          output_per_mtok: z.number().min(0),
        }),
      )
      .optional(),
  })
  .optional()

/** Merged (validated) budget section — all fields resolved, or undefined when absent. */
export const budgetMergedSchema = z
  .object({
    perIssue: z.object({ tokens: z.number().min(0), usd: z.number().min(0) }),
    perDay: z.object({ tokens: z.number().min(0), usd: z.number().min(0) }),
    onExceed: z.enum(["block", "warn"]),
    allowOverrideLabel: z.boolean(),
    pricing: z.record(
      z.string().min(1),
      z.object({ inputPerMtok: z.number().min(0), outputPerMtok: z.number().min(0) }),
    ),
  })
  .optional()

export type BudgetProjectConfig = z.infer<typeof budgetProjectSchema>
export type BudgetMergedConfig = z.infer<typeof budgetMergedSchema>

/**
 * Translate the optional `budget:` section from valley.yaml into the
 * camelCased merged shape consumed by BudgetService. Returns `undefined`
 * when the section is absent so the bootstrap can fall back to a no-op
 * service. Missing sub-fields fall back to 0 (BudgetService treats caps
 * <= 0 as disabled).
 */
export function buildBudgetConfig(project: { budget?: BudgetProjectConfig } | null): BudgetMergedConfig {
  const b = project?.budget
  if (!b) return undefined
  const pricing: Record<string, { inputPerMtok: number; outputPerMtok: number }> = {}
  if (b.pricing) {
    for (const [model, entry] of Object.entries(b.pricing)) {
      pricing[model] = {
        inputPerMtok: entry.input_per_mtok,
        outputPerMtok: entry.output_per_mtok,
      }
    }
  }
  return {
    perIssue: {
      tokens: b.per_issue?.tokens ?? 0,
      usd: b.per_issue?.usd ?? 0,
    },
    perDay: {
      tokens: b.per_day?.tokens ?? 0,
      usd: b.per_day?.usd ?? 0,
    },
    onExceed: b.on_exceed ?? "block",
    allowOverrideLabel: b.allow_override_label ?? false,
    pricing,
  }
}
