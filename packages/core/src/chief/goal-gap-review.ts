import type { GoalGapReview } from "./contracts"
import type { CoordinatorContext } from "./coordinator-stages"
import { MissionPause } from "./execution"
import { goalGapPrompt } from "./prompts"
import { parseReview } from "./schemas"
import type { ChiefTask, Mission } from "./types"

export const GOAL_GAP_REVIEW_ENV = "AV_GOAL_GAP_REVIEW"
/** A replan made for a finding is reviewed once more; after that the final review decides. */
const MAX_GOAL_GAP_REVIEWS = 2

export function goalGapReviewEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  return source[GOAL_GAP_REVIEW_ENV] === "1"
}

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
export async function reviewGoalGaps(
  context: GoalGapContext,
  source: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const { mission, run, persona, save, requestRecovery, protectedFailure, checkAbort } = context
  if (!goalGapReviewEnabled(source)) return false
  const remaining = finalWaveAhead(mission)
  if (!remaining) return false
  const key = goalGapReviewKey(mission, remaining)
  const earlier = mission.goalGapReviews ?? []
  // Looks at what a final wave returned share the list under their own key prefix and do not count here.
  const own = earlier.filter((entry) => !entry.key.startsWith("returned:"))
  if (own.length >= MAX_GOAL_GAP_REVIEWS || own.some((entry) => entry.key === key)) return false
  const ids = remaining.map((task) => task.id).join(", ")
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
  await requestRecovery(
    `Goal review before the final wave: the delivered work and the remaining tasks (${ids}) leave parts of the goal without an owner. ${review.findings.join("; ")} Replan so that a task ahead of the remaining tasks delivers each part, one task per independent part, keeping every delivered task and the remaining tasks as they are. When a finding does not hold, keep the plan and say why in the reason.`,
  )
  return true
}
