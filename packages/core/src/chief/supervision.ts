import type { SupervisionResponse } from "./schemas"
import type { ChiefPlan, ChiefTask, ChiefTaskState, Mission, SupervisionDecision } from "./types"

export function assignTaskStates(
  mission: Mission,
  plan: ChiefPlan,
  preserveEvidence = false,
  previousPlan = mission.plan,
  preserveUnchangedWork = false,
): ChiefTaskState[] {
  return plan.tasks.map((task) => {
    const reviewer =
      mission.personas.find((entry) => entry.id === mission.technicalLeadId && entry.id !== task.personaId) ??
      mission.personas.find((entry) => entry.id === "reviewer" && entry.id !== task.personaId) ??
      mission.personas.find((entry) => entry.id === mission.chiefId && entry.id !== task.personaId) ??
      mission.personas.find((entry) => entry.id !== task.personaId)
    if (!reviewer) throw new Error(`Task ${task.id} needs an independent reviewer. Configure a second Actor.`)
    const previous = preserveEvidence ? mission.tasks.find((state) => state.id === task.id) : undefined
    const unchanged = previousPlan?.tasks.some(
      (entry) => entry.id === task.id && JSON.stringify(entry) === JSON.stringify(task),
    )
    // Completed work survives an unrelated interruption: only its review refreshes against the current files.
    const preserveWork =
      unchanged &&
      previous?.output !== undefined &&
      (!previous.review || previous.review.passed) &&
      (preserveUnchangedWork || previous?.status === "completed")
    return {
      id: task.id,
      reviewerId: reviewer.id,
      status: preserveWork ? "reviewing" : "pending",
      attempts: previous?.attempts ?? 0,
      ...(previous?.repairRound !== undefined ? { repairRound: previous.repairRound } : {}),
      ...(previous?.output !== undefined && (preserveWork || previous.review || previous.effectState === "completed")
        ? { output: previous.output }
        : {}),
      ...(preserveWork && previous?.parallel && previous.status !== "completed" && !previous.review?.passed
        ? { parallel: previous.parallel }
        : {}),
      ...(previous?.review && !preserveWork ? { review: previous.review } : {}),
      ...(previous?.effectState ? { effectState: previous.effectState } : {}),
    }
  })
}

/** Key order differs between a stored plan and a re-parsed Chief response; compare task definitions by content. */
function canonicalTask(task: ChiefTask): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(task)
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  )
}

/** A targeted decision resets its named task, changed task definitions and every dependent downstream task. */
function recoveryResetTaskIds(previousPlan: ChiefPlan, plan: ChiefPlan, targetId?: string): Set<string> {
  const reset = new Set<string>()
  if (targetId) reset.add(targetId)
  for (const task of plan.tasks) {
    const previous = previousPlan.tasks.find((entry) => entry.id === task.id)
    if (!previous || canonicalTask(previous) !== canonicalTask(task)) reset.add(task.id)
  }
  for (;;) {
    const size = reset.size
    for (const task of plan.tasks)
      if (!reset.has(task.id) && task.dependencies.some((id) => reset.has(id))) reset.add(task.id)
    if (reset.size === size) return reset
  }
}

export function applyRecovery(mission: Mission, response: SupervisionResponse): void {
  if (!mission.plan) throw new Error("Chief Director recovery needs an existing plan. Restore the mission checkpoint.")
  if (response.action === "stop" || response.action === "wait") return
  const previousPlan = structuredClone(mission.plan)
  const previousStates = mission.tasks
  const interrupted = previousStates.find((state) => state.id === mission.supervision?.pendingRecovery?.taskId)
  const preserveUnchangedWork = interrupted?.output !== undefined && interrupted.review === undefined
  let plan: ChiefPlan
  let targetId: string | undefined
  if (response.action === "replan") {
    plan = { tasks: response.tasks }
    targetId = mission.supervision?.pendingRecovery?.taskId
  } else {
    targetId = response.taskId ?? mission.supervision?.pendingRecovery?.taskId
    for (const task of mission.plan.tasks) {
      if (targetId && task.id !== targetId) continue
      if (response.action === "reassign") task.personaId = response.personaId
      task.instructions = `${task.instructions.split(/\n\nChief(?: Director)? recovery:\n/)[0]}\n\nChief Director recovery:\n${response.instructions}`
    }
    plan = mission.plan
  }
  const resetTaskIds = recoveryResetTaskIds(previousPlan, plan, targetId)
  const assigned = assignTaskStates(mission, plan, true, previousPlan, preserveUnchangedWork)
  const preserved: string[] = []
  mission.plan = plan
  mission.tasks = assigned.map((state) => {
    const previous = previousStates.find((entry) => entry.id === state.id)
    // A completed approval survives a targeted decision while its recorded deliverable fingerprint stays intact.
    if (
      !resetTaskIds.has(state.id) &&
      previous?.status === "completed" &&
      previous.output !== undefined &&
      previous.review?.passed &&
      previous.fingerprint !== undefined
    ) {
      preserved.push(state.id)
      return { ...previous, reviewerId: state.reviewerId }
    }
    return state
  })
  for (const taskId of preserved)
    mission.history.push({
      at: new Date().toISOString(),
      stage: "task-preserved",
      taskId,
      message: `Kept ${taskId} completed with its passing review and deliverable fingerprint; the ${response.action} decision does not reset it.`,
    })
  // Mission-level approvals always refresh against actual files; preserved task approvals keep their recorded evidence.
  delete mission.finalReview
  delete mission.gateReviews
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
    ...(response.action === "wait" ? { retryAfterSec: response.retryAfterSec } : {}),
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
