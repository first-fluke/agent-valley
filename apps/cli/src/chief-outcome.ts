import { successfulCodeDelivery } from "@agent-valley/core/chief/code-delivery-contract"
import type { Mission } from "@agent-valley/core/chief/types"

/** Exit 2 retains an unresolved, resumable order, including operator interruption. */
export function orderExitCode(mission: Mission): 0 | 1 | 2 {
  if (mission.status === "completed") return successfulCodeDelivery(mission) ? 0 : 2
  return mission.status === "failed" ? 1 : 2
}

export function printOrderOutcome(mission: Mission): void {
  const summary = mission.status === "completed" ? (mission.finalReview?.summary ?? mission.goal) : mission.goal
  console.log(`Order ${mission.status}: ${summary}`)
  console.log(`Worktree: ${mission.workspace.path}\nBranch: ${mission.workspace.branch}`)
  if (mission.codeDelivery) {
    console.log(
      `Code delivery: ${mission.codeDelivery.phase}${mission.codeDelivery.commitSha ? ` ${mission.codeDelivery.commitSha}` : ""}`,
    )
    if (mission.codeDelivery.error) console.log(`Delivery reason: ${mission.codeDelivery.error}`)
    if (mission.codeDelivery.nextRunAt) console.log(`Next delivery observation: ${mission.codeDelivery.nextRunAt}`)
  }
  if (mission.status === "completed") return
  const reason = mission.status === "failed" ? mission.error : (mission.execution?.pauseReason ?? mission.error)
  console.log(`Reason: ${reason ?? "The goal has not reached verified completion."}`)
  if (mission.status === "waiting" && mission.execution?.nextRunAt)
    console.log(`Next attempt: ${mission.execution.nextRunAt}`)
  console.log(`Report: .agent-valley/reports/${mission.id}.md`)
}
