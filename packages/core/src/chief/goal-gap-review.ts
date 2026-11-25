import type { GoalGapReview } from "./contracts"
import type { CoordinatorContext } from "./coordinator-stages"
import { MissionPause } from "./execution"
import { goalGapPrompt } from "./prompts"
import { parseReview } from "./schemas"
import type { ChiefTask, Mission } from "./types"

/** A replan made for a finding is reviewed once more; after that the final review decides. */
const MAX_GOAL_GAP_REVIEWS = 2

/**
 * The tasks of the final wave while the mission stands right before it: earlier tasks have completed, every
 * task left depends only on completed ones, and none of them has started. A repair of the final wave has
 * started tasks and is therefore not reviewed again.
 */
export function finalWaveAhead(mission: Mission): ChiefTask[] | undefined {
  const plan = mission.plan
  if (!plan || !mission.supervision || !mission.goalBrief?.successCriteria.length) return undefined
  const done = new Set(mission.tasks.filter((state) => state.status === "completed").map((state) => state.id))
  const remaining = plan.tasks.filter((task) => !done.has(task.id))
  if (!remaining.length || !done.size) return undefined
  if (remaining.some((task) => task.dependencies.some((id) => !done.has(id)))) return undefined
  const untouched = remaining.every((task) => {
    const state = mission.tasks.find((entry) => entry.id === task.id)
    return state !== undefined && state.attempts === 0 && state.output === undefined && state.parallel === undefined
  })
  return untouched ? remaining : undefined
}

export function goalGapReviewKey(mission: Mission, remaining: readonly ChiefTask[]): string {
  const done = mission.tasks.filter((state) => state.status === "completed").map((state) => state.id)
  return `${done.sort().join(",")}|${remaining
    .map((task) => task.id)
    .sort()
    .join(",")}`
}

type GoalGapContext = Pick<
  CoordinatorContext,
  "mission" | "run" | "persona" | "save" | "requestRecovery" | "protectedFailure" | "checkAbort"
>

/**
 * Returns true when the Chief found a part of the goal without an owner and a recovery decision changed the
 * plan or its instructions; the caller then selects the next wave again.
 */
export async function reviewGoalGaps(context: GoalGapContext): Promise<boolean> {
  const { mission, run, persona, save, requestRecovery, protectedFailure, checkAbort } = context
  const remaining = finalWaveAhead(mission)
  if (!remaining) return false
  const key = goalGapReviewKey(mission, remaining)
  const earlier = mission.goalGapReviews ?? []
  // Looks at what a final wave returned share the list under their own key prefix and do not count here.
  const own = earlier.filter((entry) => !entry.key.startsWith("returned:"))
  const ids = remaining.map((task) => task.id).join(", ")
  const same = own.findLast((entry) => entry.key === key)
  // The Chief stopped on these findings and the operator resumed: the plan is unchanged, so they still have
  // no owner. The final wave used to start as if the review had passed, and only the final review said so.
  const stop = mission.supervision?.decisions.at(-1)
  if (same?.verdict === "gaps" && stop?.action === "stop" && stop.at >= same.at) {
    await save("goal-review", `The goal review before ${ids} still stands after the Chief's stop; asking again.`)
    await requestRecovery(goalGapRecovery(ids, same.findings))
    return true
  }
  if (own.length >= MAX_GOAL_GAP_REVIEWS || same) return false
  const record = (entry: Omit<GoalGapReview, "at" | "key">) => {
    mission.goalGapReviews = [...earlier, { at: new Date().toISOString(), key, ...entry }]
  }
  await save("goal-review", `Chief Director is checking the goal against the delivered work before ${ids} start.`)
  let review: ReturnType<typeof parseReview>
  try {
    review = parseReview(await run(persona(mission.chiefId), goalGapPrompt(mission, remaining), "supervise"))
  } catch (error) {
    checkAbort()
    if (error instanceof MissionPause || protectedFailure(error)) throw error
    // The review is an early look, not a gate: without a verdict the final wave starts and the final review decides.
    const reason = error instanceof Error ? error.message : String(error)
    record({ verdict: "no-verdict", summary: reason.slice(0, 500) || "No verdict.", findings: [] })
    await save(
      "goal-review",
      `The goal review before ${ids} returned no verdict; they start now. ${reason.slice(0, 300)}`,
    )
    return false
  }
  record({ verdict: review.passed ? "covered" : "gaps", summary: review.summary, findings: review.findings })
  await save("goal-review", review.summary)
  if (review.passed) return false
  await requestRecovery(goalGapRecovery(ids, review.findings))
  return true
}

/**
 * One new task per part is the shape that keeps the wave wide, but it is a preference: a goal that limits
 * its own task count once left the Chief no plan that met both rules, and it stopped a nine-hour mission
 * with six accepted tasks instead of giving three findings an owner.
 */
function goalGapRecovery(ids: string, findings: readonly string[]): string {
  return `Goal review before the final wave: the delivered work and the remaining tasks (${ids}) leave parts of the goal without an owner. ${findings.join("; ")} Replan so that every part has an owner before the mission ends, keeping every delivered task as it is. Prefer a task ahead of the remaining tasks for each independent part. When a limit in the goal or the plan leaves no room for that many tasks, group parts into fewer tasks, and when no further task is allowed, add the parts to the instructions and acceptance of a remaining task: such a limit is never a reason to stop or to leave a part unowned. When a finding does not hold, keep the plan and say why in the reason.`
}
