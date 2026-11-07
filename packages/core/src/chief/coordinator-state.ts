import type { Mission, Review } from "./types"

export class ContractViolation extends Error {}

export function createMissionContract(mission: Mission) {
  const originalDelivery = mission.codeDelivery ? structuredClone(mission.codeDelivery) : undefined
  const immutable = {
    goal: mission.goal,
    verifyCommand: mission.verifyCommand,
    operatingPolicy: JSON.stringify(mission.operatingPolicy),
    executionPolicy: JSON.stringify(mission.executionPolicy),
    metricSourcePolicy: JSON.stringify(mission.metricSourcePolicy),
    containerObservationPolicy: JSON.stringify(mission.containerObservationPolicy),
    codeDeliveryPolicy: JSON.stringify(mission.codeDelivery?.policy),
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
        JSON.stringify(mission.codeDelivery?.policy) === immutable.codeDeliveryPolicy &&
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
      if (originalDelivery && immutable.codeDeliveryPolicy) {
        mission.codeDelivery ??= structuredClone(originalDelivery)
        mission.codeDelivery.policy = JSON.parse(immutable.codeDeliveryPolicy)
      } else delete mission.codeDelivery
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
  options: { keepReviews?: boolean; preserveUnfinished?: boolean; resetTaskIds?: ReadonlySet<string> } = {},
): void {
  delete mission.observationStartedAt
  delete mission.containerObservationVerifiedFingerprint
  if (options.keepReviews && mission.gateReviews) {
    mission.gateReviews = mission.gateReviews.filter((entry) => !entry.review.passed)
  } else delete mission.gateReviews
  for (const state of mission.tasks) {
    // A scoped final-review repair keeps approved tasks the findings do not name (same rule as Chief recovery).
    if (
      options.resetTaskIds &&
      !options.resetTaskIds.has(state.id) &&
      state.status === "completed" &&
      state.output !== undefined &&
      state.review?.passed &&
      state.fingerprint !== undefined
    ) {
      mission.history.push({
        at: new Date().toISOString(),
        stage: "task-preserved",
        taskId: state.id,
        message: `Kept ${state.id} completed with its passing review and deliverable fingerprint; the final-review repair does not reset it.`,
      })
      continue
    }
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

/** Derive a final-review repair scope from the task ids its findings name, plus their transitive dependents. */
export function finalReviewRepairScope(mission: Mission, review: Review): ReadonlySet<string> | null {
  const tasks = mission.plan?.tasks ?? []
  const findings = review.findings.join("\n")
  const scope = new Set<string>()
  for (const task of tasks) {
    const escaped = task.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    if (new RegExp(`(?<![a-zA-Z0-9_-])${escaped}(?![a-zA-Z0-9_-])`).test(findings)) scope.add(task.id)
  }
  if (!scope.size) return null
  for (;;) {
    const size = scope.size
    for (const task of tasks)
      if (!scope.has(task.id) && task.dependencies.some((id) => scope.has(id))) scope.add(task.id)
    if (scope.size === size) return scope
  }
}
