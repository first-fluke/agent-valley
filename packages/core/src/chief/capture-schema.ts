import { z } from "zod"
import { reportAttachmentSchema } from "./report-delivery-contract"

export const capturePolicySchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    targetUrl: z
      .url()
      .refine((url) => /^https?:/.test(url), "Use an HTTP(S) browser URL.")
      .optional(),
    tabId: z.string().min(1).max(200).optional(),
    intervalMs: z.number().int().min(500).max(60_000).default(2_000),
    maxFrames: z.number().int().min(1).max(300).default(60),
    timeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
    video: z.boolean().default(true),
  })
  .refine((policy) => !policy.enabled || !!(policy.targetUrl || policy.tabId), {
    path: ["targetUrl"],
    message: "Set chief.capture.target_url or tab_id to bind the recording to an intended browser tab.",
  })
export type CapturePolicy = z.output<typeof capturePolicySchema>
export const captureResultSchema = z.strictObject({
  status: z.enum(["completed", "partial", "failed"]),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  frames: z.number().int().nonnegative(),
  attachments: z.array(reportAttachmentSchema).max(302),
  errors: z.array(z.string().max(2_000)).max(20),
})
export type CaptureResult = z.infer<typeof captureResultSchema>
