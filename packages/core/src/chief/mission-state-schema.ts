import { z } from "zod"
import { taskWorktreeRecordSchema } from "./parallel-workspace"

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
const text = z.string().trim().min(1).max(32_000)
const counter = z.number().int().min(0)

export const reviewSchema = z
  .strictObject({
    passed: z.boolean(),
    summary: text,
    findings: z.array(text).max(50),
    criteria: z
      .array(z.strictObject({ criterion: text, passed: z.boolean(), evidence: text }))
      .min(1)
      .max(40)
      .optional(),
  })
  .superRefine((review, ctx) => {
    if (review.passed && review.findings.length > 0) {
      ctx.addIssue({ code: "custom", message: "A passing review must have no unresolved findings." })
    }
    if (!review.passed && review.findings.length === 0) {
      ctx.addIssue({ code: "custom", message: "A rejected review must include actionable findings." })
    }
  })

export const taskStateSchema = z.strictObject({
  id,
  reviewerId: id,
  status: z.enum(["pending", "running", "reviewing", "completed"]),
  attempts: counter,
  repairRound: counter.optional(),
  output: z.string().max(32_000).optional(),
  review: reviewSchema.optional(),
  fingerprint: text.optional(),
  effectState: z.enum(["not-started", "running", "unknown", "completed"]).optional(),
  parallel: taskWorktreeRecordSchema.optional(),
})

export const verificationSchema = z.strictObject({
  ok: z.boolean(),
  output: z.string().max(32_000).optional(),
  fingerprint: text,
})

export const advisoryReviewSchema = z.strictObject({
  planKey: text,
  reviewerId: id,
  fingerprint: text,
  review: reviewSchema,
})

export const supervisionSchema = z.strictObject({
  maxRounds: z.number().int().min(1).max(50),
  rounds: counter,
  stalledRounds: counter,
  lastFingerprint: text.optional(),
  originalAcceptance: z.array(text).min(1).max(240).optional(),
  operatorGoal: text.optional(),
  operatorVerifyCommand: z.string().trim().max(32_000).optional(),
  pendingRecovery: z.strictObject({ reason: text, taskId: id.optional() }).optional(),
  decisions: z
    .array(
      z.strictObject({
        round: z.number().int().min(1).max(50),
        at: text,
        action: z.enum(["repair", "reassign", "replan", "stop"]),
        reason: text,
        fingerprint: text,
        taskId: id.optional(),
        personaId: id.optional(),
        instructions: text.optional(),
        previousTasks: z.array(taskStateSchema).max(12).optional(),
        evidence: z
          .strictObject({ finalReview: reviewSchema.optional(), verification: verificationSchema.optional() })
          .optional(),
      }),
    )
    .max(50),
})
