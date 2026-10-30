import { consultDirectors } from "./advisor-coordination"
import { refreshMissionContainers } from "./coordinator-container"
import { applyPlanningResult } from "./coordinator-results"
import type { CoordinatorContext, StageTransition } from "./coordinator-stages"
import {
  assertExecutionDeadline,
  assertNoUncertainExecution,
  chiefRecoveryStopped,
  finalizeAbandonedRuns,
  MissionPause,
} from "./execution"
import { planPrompt } from "./prompts"
import { parsePlanningResponse } from "./schemas"
import { runStructuredStage } from "./structured-stage"

export async function resumeMission(context: CoordinatorContext): Promise<StageTransition> {
  const { mission, ports, operatorGoal, operatorVerify, checkAbort, invalidate, save } = context
  finalizeAbandonedRuns(mission)
  assertNoUncertainExecution(mission)
  checkAbort()
  assertExecutionDeadline(mission)
  if (mission.execution?.failureKind === "chief-wait") {
    if (Date.parse(mission.execution.nextRunAt ?? "") > Date.now()) return { kind: "return" }
    delete mission.execution.nextRunAt
    delete mission.execution.pauseReason
    delete mission.execution.failureKind
  }
  const current = await ports.fingerprint(mission)
  mission.initialFingerprint ??= current
  if (mission.supervision) {
    mission.supervision.operatorGoal ??= operatorGoal
    mission.supervision.operatorVerifyCommand ??= operatorVerify
    mission.supervision.lastFingerprint ??= current
  }
  if (mission.fingerprint && mission.fingerprint !== current) {
    invalidate()
    await save("resume", "Worktree changed since the checkpoint; all task reviews will run again.")
  }
  mission.fingerprint = current
  delete mission.error
  delete mission.report
  for (const task of mission.tasks) {
    if (task.status === "running" || task.status === "reviewing") {
      if (task.effectState === "running") task.effectState = "unknown"
      task.status = "pending"
    }
    if (
      task.effectState === "unknown" &&
      !(mission.supervision?.pendingRecovery && mission.supervision.decisions.at(-1)?.action === "wait")
    )
      throw new MissionPause(
        `External effect ${task.id} was interrupted. No trustworthy destination proof establishes its outcome; its evidence is retained and it will not be repeated.`,
        "unknown-effect",
      )
  }
  await save("resume", "Mission checkpoint loaded.")
  const stopped = mission.supervision?.decisions.at(-1)
  if (chiefRecoveryStopped(mission))
    throw new Error(
      `Chief Director stopped before achieving the goal: ${stopped?.reason}. The original goal remains unresolved.`,
    )
  return { kind: "next", stage: "planning" }
}

export async function planMission(context: CoordinatorContext): Promise<StageTransition> {
  const { mission, ports, contract, checkpoint, run, persona, save, checkAbort, requestRecovery } = context
  if (!mission.plan) {
    await refreshMissionContainers(mission, ports)
    checkAbort()
    if (mission.containerObservationPolicy?.enabled)
      await save("container-observation", "Collected configured container evidence for mission planning.")
    await consultDirectors(mission, ports, { run, save })
    await checkpoint.transition("planning", "plan", "Chief Director is planning the mission.")
    const planned = await runStructuredStage({
      mission,
      stage: "plan",
      prompt: planPrompt(mission),
      scopeKey: mission.initialFingerprint,
      run: (prompt) => run(persona(mission.chiefId), prompt, "plan"),
      parse: (output) => parsePlanningResponse(output, mission),
      save,
    })
    applyPlanningResult(mission, planned)
    contract.pin()
    await save("plan", `Chief Director planned ${mission.tasks.length} tasks.`)
  }
  if (mission.supervision?.pendingRecovery) {
    const pending = mission.supervision.pendingRecovery
    await requestRecovery(pending.reason, pending.taskId)
  }
  return { kind: "next", stage: "tasks" }
}
