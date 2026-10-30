import { missionAdviceKey } from "./technical-lead"
import type { Mission } from "./types"

export interface UnavailableAdvice {
  stage: string
  reviewerId: string
  planKey: string
  fingerprint: string
  reason: string
}

export function unavailableDirectorAdvice(mission: Mission): UnavailableAdvice[] {
  if (mission.plan) return []
  const entries = [
    { stage: "technical-review", id: mission.technicalLeadId, review: mission.technicalReview },
    { stage: "design-review", id: mission.designLeadId, review: mission.designReview },
    { stage: "marketing-review", id: mission.marketingLeadId, review: mission.marketingReview },
  ]
  const planKey = missionAdviceKey(mission)
  return entries.flatMap((entry) => {
    if (!entry.id || (entry.review?.planKey === planKey && entry.review.fingerprint === mission.fingerprint)) return []
    for (const history of [...mission.history].reverse()) {
      if (history.stage !== "director-advice-unavailable") continue
      try {
        const evidence = JSON.parse(history.message) as UnavailableAdvice
        if (
          evidence.stage === entry.stage &&
          evidence.reviewerId === entry.id &&
          evidence.planKey === planKey &&
          evidence.fingerprint === mission.fingerprint &&
          typeof evidence.reason === "string"
        )
          return [{ ...evidence, reason: evidence.reason.slice(0, 2_000) }]
      } catch {
        /* Missing validated advice remains explicitly unavailable. */
      }
    }
    return [
      {
        stage: entry.stage,
        reviewerId: entry.id,
        planKey,
        fingerprint: mission.fingerprint ?? "unobserved",
        reason: "No validated current advisory response is recorded; this is not planning approval.",
      },
    ]
  })
}
