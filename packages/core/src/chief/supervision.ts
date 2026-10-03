import type { SupervisionResponse } from "./schemas"
import type { ChiefPlan, ChiefTaskState, Mission, SupervisionDecision } from "./types"

export function assignTaskStates(mission: Mission, plan: ChiefPlan, preserveEvidence = false): ChiefTaskState[] {
  return plan.tasks.map((task) => {
    const reviewer =
      mission.personas.find((entry) => entry.id === mission.technicalLeadId && entry.id !== task.personaId) ??
      mission.personas.find((entry) => entry.id === "reviewer" && entry.id !== task.personaId) ??
      mission.personas.find((entry) => entry.id === mission.chiefId && entry.id !== task.personaId) ??
      mission.personas.find((entry) => entry.id !== task.personaId)
    if (!reviewer) throw new Error(`Task ${task.id} needs an independent reviewer. Configure a second Actor.`)
    const previous = preserveEvidence ? mission.tasks.find((state) => state.id === task.id) : undefined
    return {
      id: task.id,
      reviewerId: reviewer.id,
      status: "pending",
      attempts: previous?.attempts ?? 0,
      ...(previous?.output ? { output: previous.output } : {}),
      ...(previous?.review ? { review: previous.review } : {}),
      ...(previous?.effectState ? { effectState: previous.effectState } : {}),
    }
  })
}

export function applyRecovery(mission: Mission, response: SupervisionResponse): void {
  if (!mission.plan) throw new Error("Chief Director recovery needs an existing plan. Restore the mission checkpoint.")
  if (response.action === "stop") return
  if (response.action === "replan") {
    const plan = { tasks: response.tasks }
    const tasks = assignTaskStates(mission, plan, true)
    mission.plan = plan
    mission.tasks = tasks
  } else {
    const targetId = response.taskId ?? mission.supervision?.pendingRecovery?.taskId
    for (const task of mission.plan.tasks) {
      if (targetId && task.id !== targetId) continue
      if (response.action === "reassign") task.personaId = response.personaId
      task.instructions = `${task.instructions.split(/\n\nChief(?: Director)? recovery:\n/)[0]}\n\nChief Director recovery:\n${response.instructions}`
    }
    mission.tasks = assignTaskStates(mission, mission.plan, true)
  }
  // Recovery can affect other tasks; every approval is refreshed against actual files.
  delete mission.finalReview
  delete mission.verification
  delete mission.goalVerification
  delete mission.observationStartedAt
  delete mission.report
}

export function recordDecision(
  mission: Mission,
  response: SupervisionResponse,
  fingerprint: string,
): SupervisionDecision {
  const decision: SupervisionDecision = {
    round: mission.supervision?.rounds ?? 0,
    at: new Date().toISOString(),
    action: response.action,
    reason: response.reason,
    fingerprint,
    ...("taskId" in response && response.taskId ? { taskId: response.taskId } : {}),
    ...("personaId" in response ? { personaId: response.personaId } : {}),
    ...("instructions" in response ? { instructions: response.instructions } : {}),
    ...(response.action === "replan" ? { previousTasks: structuredClone(mission.tasks) } : {}),
    ...(mission.finalReview || mission.verification
      ? {
          evidence: structuredClone({
            ...(mission.finalReview ? { finalReview: mission.finalReview } : {}),
            ...(mission.verification ? { verification: mission.verification } : {}),
          }),
        }
      : {}),
  }
  mission.supervision?.decisions.push(decision)
  return decision
}
