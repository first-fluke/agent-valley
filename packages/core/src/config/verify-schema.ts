/**
 * Verification-gate schema — extracted from yaml-loader.ts to keep that
 * file under the 500-line cap (CONSTRAINTS.md §5), mirroring the existing
 * observability-schema.ts / tunnel-schema.ts split.
 *
 * Backwards compat: when the top-level `verify:` block is omitted, `command`
 * resolves to `undefined` and the verification gate is a documented no-op
 * (see orchestrator/verification-gate.ts).
 */

import { z } from "zod"

export const DEFAULT_VERIFY_TIMEOUT_SEC = 600

/** Project-level (valley.yaml) verify section — omit entirely to disable the gate. */
export const verifyProjectSchema = z
  .object({
    command: z.string().min(1, "verify.command must be a non-empty shell command").optional(),
    timeout_sec: z.number().min(1, "verify.timeout_sec must be >= 1").optional(),
  })
  .optional()

/** Merged (validated) verify section — always present; `command` is undefined when unset (gate is a no-op). */
export const verifyMergedSchema = z.object({
  command: z.string().optional(),
  timeoutSec: z.number().min(1),
})

export type VerifyProjectConfig = z.infer<typeof verifyProjectSchema>
export type VerifyConfig = z.infer<typeof verifyMergedSchema>

/** Produce the merged verify block from the raw project config. */
export function buildVerifyConfig(project: { verify?: VerifyProjectConfig } | null | undefined): VerifyConfig {
  return {
    command: project?.verify?.command,
    timeoutSec: project?.verify?.timeout_sec ?? DEFAULT_VERIFY_TIMEOUT_SEC,
  }
}
