import { containersHealthy } from "./container-observation-state"
import { assertExecutionBudget, chiefRecoveryStopped, MissionPause } from "./execution"
import { validateFinalReview } from "./goal-evidence"
import { validateMission } from "./schemas"
import type { Mission } from "./types"

export interface AutomaticMissionRecovery {
  retry: boolean
  reason: string
  waitUntil?: string
}

export interface AutomaticRecoveryContext {
  completionEvidenceUnavailable?: boolean
  reason?: string
}

/** A passing final review cannot replace unfinished tasks or verification of a different worktree. */
export function verifiedMissionEvidence(mission: Mission): boolean {
  const plan = mission.plan
  const review = mission.finalReview
  if (
    !plan?.tasks.length ||
    !review?.passed ||
    !mission.verification?.ok ||
    !mission.fingerprint?.trim() ||
    mission.verification.fingerprint !== mission.fingerprint ||
    mission.tasks.length !== plan.tasks.length ||
    review.criteria?.some((criterion) => !criterion.passed || !criterion.evidence.trim()) ||
    !mission.tasks.every(
      (task) =>
        task.status === "completed" &&
        task.fingerprint?.trim() &&
        task.review?.passed &&
        task.review.summary.trim() &&
        task.effectState !== "unknown" &&
        task.effectState !== "running",
    ) ||
    !plan.tasks.every((task) => {
      const state = mission.tasks.find((entry) => entry.id === task.id)
      return (
        state?.status === "completed" &&
        state.review?.passed &&
        (task.effectScope !== "external" || state.effectState === "completed")
      )
    })
  )
    return false
  try {
    return validateFinalReview(structuredClone(review), validateMission(structuredClone(mission))).passed
  } catch {
    return false
  }
}

export function scheduledChiefWait(mission: Mission): boolean {
  return (
    mission.status === "waiting" &&
    mission.execution?.failureKind === "chief-wait" &&
    mission.supervision?.decisions.at(-1)?.action === "wait" &&
    Number.isFinite(Date.parse(mission.execution.nextRunAt ?? ""))
  )
}

/** Eligibility only: never resets usage, limits, assignments, effects or the Chief's decision. */
export function automaticMissionRecovery(
  mission: Mission,
  now = Date.now(),
  context: AutomaticRecoveryContext = {},
): AutomaticMissionRecovery {
  const stop = (reason: string): AutomaticMissionRecovery => ({ retry: false, reason })
  if (!mission.executionPolicy?.autoResume) return stop("Automatic recovery is disabled by the saved policy.")
  const state = mission.execution
  if (!Number.isFinite(now) || (state && !Number.isFinite(Date.parse(state.startedAt))))
    return stop("The saved execution timestamp is invalid; automatic recovery is stopped.")
  if (String(state?.failureKind) === "integrity")
    return stop(state?.pauseReason ?? "The immutable mission contract or checkpoint has an integrity failure.")
  if (String(state?.failureKind) === "chief-unavailable")
    return stop(state?.pauseReason ?? "The selected Chief is unavailable; its identity and checkpoint were retained.")
  const lastDecision = mission.supervision?.decisions.at(-1)
  // Only this saved Chief decision authorizes another read-only observation of an unknown effect.
  const unknownChiefWait = scheduledChiefWait(mission) && !!mission.supervision?.pendingRecovery
  if (
    !unknownChiefWait &&
    (mission.tasks.some((task) => task.effectState === "unknown") || state?.failureKind === "unknown-effect")
  )
    return stop("The child has an unknown external effect; its recorded effects remain protected.")
  if (state?.failureKind === "interrupted") return stop("The operation was cancelled; automatic recovery is stopped.")
  if (state?.failureKind === "budget") return stop(state.pauseReason ?? "The saved execution budget is exhausted.")
  if (mission.status === "waiting" && !Number.isFinite(Date.parse(state?.nextRunAt ?? "")))
    return stop("The saved recovery timestamp is missing or invalid; automatic recovery is stopped.")
  if (chiefRecoveryStopped(mission))
    return stop(`The Chief stopped recovery: ${lastDecision?.reason ?? "Saved stop decision"}`)
  if (
    /read-only|identity|immutable operator contract|Mission goal, success criteria or operator verification changed|original (?:record|checkpoint|contract|goal)|checkpoint.*(?:could not|cannot|failed|writ|differ|match|changed)|budget reservation.*saved|contract.*changed|workspace.*(?:differ|match)/i.test(
      mission.error ?? state?.pauseReason ?? "",
    )
  )
    return stop("The saved checkpoint has an integrity failure; automatic recovery is stopped.")
  try {
    assertExecutionBudget(structuredClone(mission), now)
  } catch (error) {
    if (error instanceof MissionPause) return stop(error.message)
    throw error
  }
  const supervision = mission.supervision
  if (supervision && (supervision.rounds >= supervision.maxRounds || supervision.stalledRounds >= 3))
    return stop("The Chief exhausted its saved recovery rounds; the goal remains unresolved.")
  if (mission.status === "waiting" && state?.nextRunAt) {
    if (!Number.isFinite(Date.parse(state.nextRunAt))) return stop("The saved recovery timestamp is invalid.")
    return {
      retry: true,
      reason: state.pauseReason ?? "Continue the scheduled Chief recovery.",
      waitUntil: state.nextRunAt,
    }
  }
  const verified =
    !context.completionEvidenceUnavailable &&
    verifiedMissionEvidence(mission) &&
    (!mission.containerObservationPolicy?.enabled ||
      (containersHealthy(mission.containerObservationPolicy, mission.containerObservation) &&
        mission.containerObservationVerifiedFingerprint === mission.containerObservation?.fingerprint))
  if (mission.status === "completed")
    return verified
      ? stop("The child is already verified and completed.")
      : supervision
        ? {
            retry: true,
            reason: context.reason ?? "The Chief must review the same child's unresolved completion evidence.",
          }
        : stop("The completed child has no saved Chief recovery policy.")
  if (["paused", "failed"].includes(mission.status)) {
    if (!supervision?.pendingRecovery) return stop(mission.error ?? "No saved Chief recovery request is available.")
    return { retry: true, reason: supervision.pendingRecovery.reason }
  }
  return { retry: true, reason: "Continue the original child's saved execution stage." }
}

export const automaticRecoveryLimit = 3
