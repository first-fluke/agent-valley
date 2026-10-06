import { z } from "zod"
import { taskWorktreeRecordSchema } from "./parallel-workspace"
import type { Mission } from "./types"

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
      z
        .strictObject({
          round: z.number().int().min(1).max(50),
          at: text,
          action: z.enum(["repair", "reassign", "replan", "stop", "wait"]),
          retryAfterSec: z.number().int().min(1).max(86_400).optional(),
          reason: text,
          fingerprint: text,
          taskId: id.optional(),
          personaId: id.optional(),
          instructions: text.optional(),
          previousTasks: z.array(taskStateSchema).max(12).optional(),
          evidence: z
            .strictObject({ finalReview: reviewSchema.optional(), verification: verificationSchema.optional() })
            .optional(),
        })
        .superRefine((decision, ctx) => {
          if ((decision.action === "wait") !== (decision.retryAfterSec !== undefined))
            ctx.addIssue({
              code: "custom",
              path: ["retryAfterSec"],
              message: "Only a Chief wait decision must carry a bounded retry delay.",
            })
          if (decision.action === "wait" && !z.iso.datetime().safeParse(decision.at).success)
            ctx.addIssue({
              code: "custom",
              path: ["at"],
              message: "Chief wait decisions require their original ISO timestamp.",
            })
        }),
    )
    .max(50),
})

export function refineChiefWaitSchedule(
  mission: Pick<Mission, "supervision" | "execution">,
  ctx: z.RefinementCtx,
): void {
  if (mission.execution?.failureKind !== "chief-wait") return
  const waiting = mission.supervision?.decisions.at(-1)
  const at = Date.parse(waiting?.at ?? "")
  if (
    waiting?.action !== "wait" ||
    !waiting.retryAfterSec ||
    !Number.isFinite(at) ||
    mission.execution.nextRunAt !== new Date(at + waiting.retryAfterSec * 1_000).toISOString()
  )
    ctx.addIssue({
      code: "custom",
      path: ["execution", "nextRunAt"],
      message:
        "Saved Chief wait schedule does not match its decision. Restore the original wait checkpoint without resetting its budget.",
    })
}
