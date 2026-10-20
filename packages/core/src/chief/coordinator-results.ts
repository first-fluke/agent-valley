import { recordTaskVerdict } from "./routing"
import type { parsePlanningResponse } from "./schemas"
import { assignTaskStates } from "./supervision"
import type { ChiefPlan, ChiefPorts, ChiefTask, ChiefTaskState, Mission, Review, Verification } from "./types"
import { goalVerificationContractDigest } from "./verification"

/** Apply parsed results without scheduling work or writing checkpoints. */
export function applyPlanningResult(
  mission: Mission,
  planned: ReturnType<typeof parsePlanningResponse>,
): asserts mission is Mission & { plan: ChiefPlan } {
  const tasks = assignTaskStates({ ...mission, personas: planned.personas }, planned.plan)
  mission.personas = planned.personas
  mission.plan = planned.plan
  mission.tasks = tasks
  if (planned.goalBrief) {
    mission.goalBrief = planned.goalBrief
    if (mission.supervision)
      mission.supervision.originalAcceptance = [...new Set(planned.plan.tasks.flatMap((task) => task.acceptance))]
  }
  if (planned.verificationContract) {
    mission.verificationContract = planned.verificationContract
    mission.verificationContractSha256 = goalVerificationContractDigest(planned.verificationContract)
  }
}

export function applyWorkResult(task: ChiefTask, state: ChiefTaskState, output: string): void {
  state.output = output.slice(-32_000)
  if (task.effectScope === "external") state.effectState = "completed"
}

export function applyTaskReviewResult(
  mission: Mission,
  state: ChiefTaskState,
  review: Review,
): asserts state is ChiefTaskState & { review: Review } {
  state.review = review
  recordTaskVerdict(mission, state.id, review.passed, review.summary)
  state.fingerprint = mission.fingerprint
}

export function applyVerificationResult(
  mission: Mission,
  result: Awaited<ReturnType<ChiefPorts["verify"]>>,
  fingerprint: string,
): asserts mission is Mission & { verification: Verification } {
  mission.fingerprint = fingerprint
  mission.verification = {
    ok: result.ok,
    output: result.output ? result.output.slice(-32_000) : undefined,
    fingerprint,
  }
  if (mission.verificationMode === "chief" && !mission.goalVerification?.ok) {
    mission.verification.ok = false
    mission.verification.output =
      mission.goalVerification?.output ??
      "No actual goal verification observations were recorded. Execute the immutable checks."
  }
  if (mission.fingerprint === mission.initialFingerprint) {
    mission.verification.ok = false
    mission.verification.output =
      "No material deliverable changed in the worktree. Create the requested code or report artifact."
  }
}
