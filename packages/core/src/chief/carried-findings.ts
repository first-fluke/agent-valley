import type { ChiefPlan, ChiefTask, ChiefTaskState, Mission } from "./types"

/** A severe defect or a failed check is never deferred to a later task; the Chief decides on those. */
const HELD_GROUND = /^\s*(SEVERE|CHECK)\s*:/i
const TEXT_LIMIT = 32_000
const ACCEPTANCE_LIMIT = 40
const ORIGINAL_ACCEPTANCE_LIMIT = 240
const FOLLOW_UP_LIMIT = 50

/** The last task that builds on `id`, directly or through other tasks, and has not started. */
function lastWaitingDependent(plan: ChiefPlan, states: readonly ChiefTaskState[], id: string): ChiefTask | undefined {
  const after = new Set([id])
  for (;;) {
    const size = after.size
    for (const task of plan.tasks) if (task.dependencies.some((entry) => after.has(entry))) after.add(task.id)
    if (after.size === size) break
  }
  const waiting = plan.tasks.filter((task) => {
    const state = states.find((entry) => entry.id === task.id)
    return (
      task.id !== id &&
      after.has(task.id) &&
      task.effectScope !== "external" &&
      state?.status === "pending" &&
      state.output === undefined &&
      state.review === undefined &&
      !state.parallel
    )
  })
  return waiting.findLast((task) => !waiting.some((other) => other.dependencies.includes(task.id)))
}

/**
 * Hands the open findings of a task whose local repairs are spent to the last task that builds on it.
 *
 * A rejected delivery is integrated in the mission workspace either way, yet its review used to hold every
 * later task until it passed. Once the repairs were spent, each further rejection cost a Chief recovery
 * round, another Actor run, an integration check and a review: one mission kept two tasks in that loop for
 * nine hours over how strictly a test proved an edge case, while its QA and integration tasks never started.
 *
 * The delivery now stands as integrated and each open finding becomes an acceptance obligation of the
 * receiving task, where that task's own review and the final review still judge it. A finding that reports
 * a severe defect or a failed check is not carried, and a task nothing waits on has no later owner: both
 * stay with the Chief's recovery decision.
 *
 * Returns the checkpoint message, or undefined when nothing was carried.
 */
export function carryOpenFindings(mission: Mission, taskId: string): string | undefined {
  const plan = mission.plan
  const task = plan?.tasks.find((entry) => entry.id === taskId)
  const state = mission.tasks.find((entry) => entry.id === taskId)
  const review = state?.review
  // A replan drops the task's fingerprint; the integrated tree it was reviewed in is the mission's.
  const fingerprint = state?.fingerprint ?? mission.fingerprint
  if (!plan || !task || !state || !review || review.passed || !fingerprint) return undefined
  if (state.status === "completed" || task.effectScope === "external") return undefined
  const repairs = state.repairRound ?? 0
  if (repairs < 1 || repairs < mission.maxRepairs) return undefined
  if (review.findings.some((finding) => HELD_GROUND.test(finding))) return undefined
  const receiver = lastWaitingDependent(plan, mission.tasks, taskId)
  if (!receiver) return undefined
  const obligations = review.findings.map((finding) =>
    `Carried from ${taskId}; resolved in this task or shown with evidence not to apply: ${finding}`.slice(
      0,
      TEXT_LIMIT,
    ),
  )
  const instructions = `${receiver.instructions}\n\nFindings carried from ${taskId}: its delivery stands as integrated after ${repairs} repair(s), and its review left open the findings listed in this task's acceptance. Resolve each one in this task, including in the files the finding names, or show with evidence that it does not apply.`
  const original = mission.supervision?.originalAcceptance
  if (
    instructions.length > TEXT_LIMIT ||
    receiver.acceptance.length + obligations.length > ACCEPTANCE_LIMIT ||
    (original && original.length + obligations.length > ORIGINAL_ACCEPTANCE_LIMIT)
  )
    return undefined
  receiver.instructions = instructions
  receiver.acceptance = [...receiver.acceptance, ...obligations]
  // A later replan has to keep these obligations, like every other original acceptance entry.
  original?.push(...obligations)
  const note = ` Agent Valley carried ${obligations.length} open finding(s) to ${receiver.id} after ${repairs} repair(s); the delivery stands as integrated.`
  state.status = "completed"
  state.fingerprint = fingerprint
  state.carriedTo = receiver.id
  // A rejected isolated delivery keeps no Actor output; the record still says what the task left behind.
  state.output ??= `The delivery of ${taskId} is integrated in the mission workspace. Its review findings were carried to ${receiver.id}.`
  state.review = {
    passed: true,
    summary: `${review.summary.slice(0, TEXT_LIMIT - note.length)}${note}`,
    findings: [],
    followUps: [
      ...review.findings.map((finding) => `Carried to ${receiver.id}: ${finding}`.slice(0, TEXT_LIMIT)),
      ...(review.followUps ?? []),
    ].slice(0, FOLLOW_UP_LIMIT),
  }
  delete state.previousReview
  return `Task ${taskId} stands as integrated after ${repairs} repair(s); its ${obligations.length} open finding(s) are now acceptance obligations of ${receiver.id}.`
}
