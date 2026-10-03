import { assessMetricTargets, metricTargetCriterion } from "./organization"
import type { Mission, Review } from "./types"
import { validateGoalVerificationResult } from "./verification"

export function finalCriteria(mission: Mission): string[] {
  return [
    ...new Set([
      ...(mission.goalBrief?.successCriteria ?? []),
      ...(mission.operatingPolicy?.metricTargets ?? []).map(metricTargetCriterion),
    ]),
  ]
}

/** An LLM's business verdict cannot override actual operator-recorded measurements. */
export function validateFinalReview(review: Review, mission: Mission): Review {
  if (!mission.supervision && !mission.operatingPolicy?.metricTargets?.length) return review
  const expected = finalCriteria(mission)
  const assessed = review.criteria ?? []
  if (
    !expected.length ||
    assessed.length !== expected.length ||
    new Set(assessed.map((entry) => entry.criterion)).size !== assessed.length ||
    assessed.some((entry) => !expected.includes(entry.criterion))
  )
    throw new Error("Final review must assess every original success criterion exactly once with actual evidence.")
  if (review.passed !== assessed.every((entry) => entry.passed))
    throw new Error(
      "Final review passed must match all criterion assessments. Reject unmet criteria with actionable findings.",
    )
  const metrics = assessMetricTargets(mission.organizationContext, mission.operatingPolicy?.metricTargets ?? [])
  if (mission.verificationMode === "chief" && (!mission.goalVerification || !mission.verificationContract))
    throw new Error(
      "Chief goal checks have no actual observations. Run the pinned verification contract before final review.",
    )
  if (mission.goalVerification && mission.verificationContract) {
    const result = validateGoalVerificationResult(mission.goalVerification, mission.verificationContract)
    for (const observed of result.evidence) {
      const criterion = assessed.find((entry) => entry.criterion === observed.criterion)
      if (!observed.passed && criterion) {
        criterion.passed = false
        criterion.evidence = observed.checks.map((check) => check.summary).join("; ")
        review.findings.push(`${observed.criterion}: ${criterion.evidence}`)
        review.passed = false
      }
    }
  }
  for (const metric of metrics) {
    const criterion = assessed.find((entry) => entry.criterion === metric.criterion)
    if (!metric.passed && criterion) {
      criterion.passed = false
      criterion.evidence = metric.evidence
      review.findings.push(`${metric.criterion}: ${metric.evidence}`)
      review.passed = false
    }
  }
  return review
}
