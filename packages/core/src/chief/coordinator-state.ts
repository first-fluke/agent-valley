import type { Mission } from "./types"

export class ContractViolation extends Error {}

export function createMissionContract(mission: Mission) {
  const immutable = {
    goal: mission.goal,
    verifyCommand: mission.verifyCommand,
    operatingPolicy: JSON.stringify(mission.operatingPolicy),
    executionPolicy: JSON.stringify(mission.executionPolicy),
    metricSourcePolicy: JSON.stringify(mission.metricSourcePolicy),
    containerObservationPolicy: JSON.stringify(mission.containerObservationPolicy),
  }
  let brief = mission.goalBrief ? JSON.stringify(mission.goalBrief) : undefined
  let checks = mission.verificationContract ? JSON.stringify(mission.verificationContract) : undefined
  let digest = mission.verificationContractSha256
  return {
    pin() {
      brief = mission.goalBrief ? JSON.stringify(mission.goalBrief) : undefined
      checks = mission.verificationContract ? JSON.stringify(mission.verificationContract) : undefined
      digest = mission.verificationContractSha256
    },
    assert() {
      if (
        mission.goal === immutable.goal &&
        mission.verifyCommand === immutable.verifyCommand &&
        JSON.stringify(mission.operatingPolicy) === immutable.operatingPolicy &&
        JSON.stringify(mission.executionPolicy) === immutable.executionPolicy &&
        JSON.stringify(mission.metricSourcePolicy) === immutable.metricSourcePolicy &&
        JSON.stringify(mission.containerObservationPolicy) === immutable.containerObservationPolicy &&
        (!brief || JSON.stringify(mission.goalBrief) === brief) &&
        (!checks || JSON.stringify(mission.verificationContract) === checks) &&
        mission.verificationContractSha256 === digest
      )
        return
      mission.goal = immutable.goal
      mission.verifyCommand = immutable.verifyCommand
      mission.operatingPolicy = immutable.operatingPolicy ? JSON.parse(immutable.operatingPolicy) : undefined
      mission.executionPolicy = immutable.executionPolicy ? JSON.parse(immutable.executionPolicy) : undefined
      mission.metricSourcePolicy = immutable.metricSourcePolicy ? JSON.parse(immutable.metricSourcePolicy) : undefined
      mission.containerObservationPolicy = immutable.containerObservationPolicy
        ? JSON.parse(immutable.containerObservationPolicy)
        : undefined
      if (brief) mission.goalBrief = JSON.parse(brief)
      if (checks) mission.verificationContract = JSON.parse(checks)
      mission.verificationContractSha256 = digest
      throw new ContractViolation(
        "Mission goal, success criteria or operator verification changed. Restore the immutable operator contract.",
      )
    },
  }
}

/** Partial deliveries survive drift; repair deliberately creates a new Actor attempt. */
export function resetTaskApprovals(
  mission: Mission,
  options: { keepReviews?: boolean; preserveUnfinished?: boolean } = {},
): void {
  delete mission.observationStartedAt
  delete mission.containerObservationVerifiedFingerprint
  for (const state of mission.tasks) {
    const preserve = options.preserveUnfinished && state.parallel && state.status !== "completed"
    state.status = "pending"
    if (!options.keepReviews) delete state.review
    delete state.fingerprint
    if (!preserve) {
      if (state.parallel)
        mission.history.push({
          at: new Date().toISOString(),
          stage: "parallel-retained",
          taskId: state.id,
          message: `Previous Actor workspace record retained in history: ${state.parallel.path}.`,
        })
      delete state.parallel
      if (state.effectState !== "completed") delete state.output
    }
  }
}
