import type { Mission } from "./types"

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
