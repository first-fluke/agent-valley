import { isAbsolute } from "node:path"
import { z } from "zod"
import type { ReportAttachment, ReportChannelRegistry } from "../domain/ports/report-channel"

const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "Use an environment variable name, never its secret value.")
export const MAX_REPORT_ATTACHMENTS = 303
export const reportDestinationSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  channel: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  url_env: envName.optional(),
  token_env: envName.optional(),
  chat_id_env: envName.optional(),
  channel_id_env: envName.optional(),
  space_env: envName.optional(),
  team_id_env: envName.optional(),
  drive_id_env: envName.optional(),
  base_url_env: envName.optional(),
})

export const reportDeliveryPolicySchema = z
  .strictObject({
    destinations: z.array(reportDestinationSchema).max(20),
    events: z
      .array(z.enum(["completed", "failed"]))
      .min(1)
      .max(2)
      .default(["completed", "failed"]),
    timeout_ms: z.number().int().min(1_000).max(60_000).default(10_000),
    max_attempts: z.number().int().min(1).max(10).default(3),
  })
  .superRefine((policy, ctx) => {
    if (new Set(policy.destinations.map((entry) => entry.id)).size !== policy.destinations.length)
      ctx.addIssue({ code: "custom", path: ["destinations"], message: "Give every report destination a unique id." })
    if (new Set(policy.events).size !== policy.events.length)
      ctx.addIssue({ code: "custom", path: ["events"], message: "List each report event once." })
  })

export const reportAttachmentSchema = z.strictObject({
  path: z.string().max(4_096).refine(isAbsolute, "Use an absolute capture artifact path."),
  name: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^/\\\r\n\0]+$/, "Use a filename without directories."),
  mimeType: z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i),
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(200 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})

export type ReportDeliveryPolicy = z.input<typeof reportDeliveryPolicySchema>
export type ResolvedReportDeliveryPolicy = z.output<typeof reportDeliveryPolicySchema>
export type ReportDestination = z.infer<typeof reportDestinationSchema>
export type { ReportAttachment, ReportChannelRegistry } from "../domain/ports/report-channel"

export interface ReportDeliveryDependencies {
  fetch: typeof globalThis.fetch
  env: Record<string, string | undefined>
  registry: ReportChannelRegistry
  attachments: ReportAttachment[]
  artifactRoot: string
  now: () => Date
}

export interface ReportDeliveryReceipt {
  id: string
  missionId: string
  missionStatus: "completed" | "failed"
  destinationId: string
  channel: string
  reportHash: string
  status: "delivered" | "pending" | "failed"
  attempts: number
  nextPart: number
  parts: number
  createdAt: string
  updatedAt: string
  message: string
}

export class ReportDeliveryError extends Error {
  constructor(
    message: string,
    readonly pending = false,
    readonly retryable = true,
  ) {
    super(message)
  }
}
