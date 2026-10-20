import { z } from "zod"
import { reviewSchema } from "./mission-state-schema"
import type { Mission } from "./types"

const id = z
  .string()
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/,
    "Use 1–64 letters, numbers, underscores or hyphens, starting with a letter or number.",
  )
const text = z.string().trim().min(1).max(32_000)

export const reviewGateSchema = z.strictObject({ id, instructions: text })
export const reviewGatesSchema = z
  .array(reviewGateSchema)
  .max(8)
  .superRefine((gates, ctx) => {
    if (new Set(gates.map((gate) => gate.id)).size !== gates.length)
      ctx.addIssue({
        code: "custom",
        message: "Chief review gate IDs must be unique. Set distinct chief.review_gates[].id values.",
      })
  })
export type ReviewGate = z.infer<typeof reviewGateSchema>

export const gateReviewSchema = z.strictObject({
  gateId: id,
  taskId: id,
  reviewerId: id,
  fingerprint: text,
  review: reviewSchema,
})
export type GateReview = z.infer<typeof gateReviewSchema>

/** Ordinary task approvals and specialized gates attest to different checks of the same files. */
export function reviewGatesAreCurrent(mission: Mission, fingerprint: string | undefined): boolean {
  const gates = mission.operatingPolicy?.reviewGates ?? []
  if (!gates.length) return true
  if (!fingerprint || !mission.plan) return false
  return gates.every((gate) =>
    mission.plan?.tasks.every((task) =>
      mission.gateReviews?.some(
        (entry) =>
          entry.gateId === gate.id &&
          entry.taskId === task.id &&
          entry.reviewerId !== task.personaId &&
          entry.review.passed &&
          entry.fingerprint === fingerprint,
      ),
    ),
  )
}
