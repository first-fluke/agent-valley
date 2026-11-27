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

/** Criteria the operator accepted as unmet for this mission, with the recorded reason. */
export function waivedCriteria(mission: Mission): Map<string, string> {
  return new Map((mission.criterionWaivers ?? []).map((waiver) => [waiver.criterion, waiver.reason]))
}

export const REPEATED_FINAL_REVIEW_ENV = "AV_REPEATED_FINAL_REVIEW"

/**
 * What happens when the final review fails again on the same criteria after a repair. `pause` (the default)
 * waits for the operator; `record-unmet` records those criteria as unmet in this mission, with the review's
 * findings as the reason, so the verified work is delivered and the findings can become the next goal.
 */
export function repeatedFinalReviewPolicy(source: NodeJS.ProcessEnv = process.env): "pause" | "record-unmet" {
  return source[REPEATED_FINAL_REVIEW_ENV]?.trim() === "record-unmet" ? "record-unmet" : "pause"
}

export function recordRepeatedCriteriaUnmet(
  mission: Mission,
  criteria: readonly string[],
  findings: readonly string[],
): void {
  const at = new Date().toISOString()
  const reason =
    `Recorded unmet under the operator's ${REPEATED_FINAL_REVIEW_ENV}=record-unmet policy: the final review failed on this criterion again after a repair. Its findings: ${findings.join(" ")}`.slice(
      0,
      1_000,
    )
  mission.criterionWaivers = [
    ...(mission.criterionWaivers ?? []).filter((waiver) => !criteria.includes(waiver.criterion)),
    ...criteria.map((criterion) => ({ at, criterion, reason })),
  ]
}

/** Unmet criteria that still hold the mission open: every failed assessment the operator did not waive. */
export function blockingCriteria(review: Review | undefined): string[] {
  return (review?.criteria ?? []).filter((entry) => !entry.passed && !entry.waived).map((entry) => entry.criterion)
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
  // A success criterion is immutable, so an operator who decides it stays unmet in this mission could only
  // abandon the mission. A recorded waiver keeps the assessment truthful (the criterion still fails) and
  // stops it from holding the mission open.
  const waived = waivedCriteria(mission)
  for (const entry of assessed) {
    if (!entry.passed && waived.has(entry.criterion)) entry.waived = true
    else delete entry.waived
  }
  const blockingPass = assessed.every((entry) => entry.passed || entry.waived)
  if (review.passed !== blockingPass) {
    // A reviewer that still counted a waived criterion rejected only because of it.
    if (review.passed || !blockingPass || !assessed.some((entry) => entry.waived))
      throw new Error(
        "Final review passed must match all criterion assessments. Reject unmet criteria with actionable findings.",
      )
    review.passed = true
    review.findings = []
  }
  const metrics = assessMetricTargets(mission.organizationContext, mission.operatingPolicy?.metricTargets ?? [])
  if (mission.verificationMode === "chief" && (!mission.goalVerification || !mission.verificationContract))
    throw new Error(
      "Chief goal checks have no actual observations. Run the pinned verification contract before final review.",
    )
  if (mission.goalVerification && mission.verificationContract) {
    const result = validateGoalVerificationResult(
      mission.goalVerification,
      mission.verificationContract,
      new Set(waived.keys()),
    )
    for (const observed of result.evidence) {
      const criterion = assessed.find((entry) => entry.criterion === observed.criterion)
      if (!observed.passed && criterion) {
        criterion.passed = false
        criterion.evidence = observed.checks.map((check) => check.summary).join("; ")
        if (waived.has(criterion.criterion)) {
          criterion.waived = true
          continue
        }
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
      if (waived.has(criterion.criterion)) {
        criterion.waived = true
        continue
      }
      review.findings.push(`${metric.criterion}: ${metric.evidence}`)
      review.passed = false
    }
  }
  return review
}
