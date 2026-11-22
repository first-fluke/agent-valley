import type { GoalGapReview } from "./contracts"
import type { CoordinatorContext } from "./coordinator-stages"
import { finalReviewRepairScope } from "./coordinator-state"
import { MissionPause } from "./execution"
import { goalGapReviewEnabled } from "./goal-gap-review"
import { returnedFindingsPrompt } from "./prompts"
import { parseReview } from "./schemas"
import type { ChiefTask, Mission } from "./types"

/** Keys of these looks in `mission.goalGapReviews`; the goal review before a final wave ignores them. */
export const RETURNED_FINDINGS_KEY = "returned:"
/** A repair made for a finding is looked at once more; after that the final review decides. */
const MAX_RETURNED_FINDINGS_REVIEWS = 2

/**
 * True while `returned` is the whole rest of the mission: every other task has completed and each returned
 * task has an output. Only then do the integrated check, verification and the final review follow directly,
 * so a blocking defect one output names would otherwise be acted on a full check and verification later.
 */
export function finalWaveReturned(mission: Mission, returned: readonly ChiefTask[]): boolean {
  if (!returned.length || !mission.supervision || !mission.goalBrief?.successCriteria.length) return false
  const ids = new Set(returned.map((task) => task.id))
  let completed = 0
  for (const state of mission.tasks) {
    if (ids.has(state.id)) {
      if (state.output === undefined) return false
    } else if (state.status !== "completed") return false
    else completed += 1
  }
  return completed > 0
}

export function returnedFindingsKey(mission: Mission, returned: readonly ChiefTask[]): string {
  const attempts = (id: string) => mission.tasks.find((state) => state.id === id)?.attempts ?? 0
  return `${RETURNED_FINDINGS_KEY}${returned
    .map((task) => `${task.id}#${attempts(task.id)}`)
    .sort()
    .join(",")}`
}

type ReturnedFindingsContext = Pick<
  CoordinatorContext,
  "mission" | "run" | "persona" | "save" | "requestRepair" | "protectedFailure" | "checkAbort"
>

/**
 * A QA task ran in the final wave beside the integration task and recorded two blocking defects in a lane's
 * tests. Its own review passed, because the record was accurate, and nothing acted on the defects until the
 * final review rejected for them: one 53-minute integrated check, one verification and one final review later.
 *
 * The Chief reads what the final wave returned as soon as it is integrated. Returns true when an output names
 * a blocking defect that is still open and the owning tasks were sent to repair; the wave then stops before
 * its integrated check and reviews.
 */
export async function reviewReturnedFindings(
  context: ReturnedFindingsContext,
  returned: readonly ChiefTask[],
  source: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const { mission, run, persona, save, requestRepair, protectedFailure, checkAbort } = context
  if (!goalGapReviewEnabled(source) || !finalWaveReturned(mission, returned)) return false
  const key = returnedFindingsKey(mission, returned)
  const earlier = mission.goalGapReviews ?? []
  const looks = earlier.filter((entry) => entry.key.startsWith(RETURNED_FINDINGS_KEY))
  if (looks.length >= MAX_RETURNED_FINDINGS_REVIEWS || looks.some((entry) => entry.key === key)) return false
  const ids = returned.map((task) => task.id).join(", ")
  const record = (entry: Omit<GoalGapReview, "at" | "key">) => {
    mission.goalGapReviews = [...earlier, { at: new Date().toISOString(), key, ...entry }]
  }
  await save("returned-findings", `Chief Director is reading what ${ids} returned before the integrated check.`)
  let review: ReturnType<typeof parseReview>
  try {
    review = parseReview(
      await run(persona(mission.chiefId), returnedFindingsPrompt(mission, [...returned]), "supervise"),
    )
  } catch (error) {
    checkAbort()
    if (error instanceof MissionPause || protectedFailure(error)) throw error
    // An early look, not a gate: without a verdict the wave goes on and the final review decides.
    const reason = error instanceof Error ? error.message : String(error)
    record({ verdict: "no-verdict", summary: reason.slice(0, 500) || "No verdict.", findings: [] })
    await save(
      "returned-findings",
      `The look at what ${ids} returned gave no verdict; the wave goes on. ${reason.slice(0, 300)}`,
    )
    return false
  }
  record({ verdict: review.passed ? "covered" : "gaps", summary: review.summary, findings: review.findings })
  await save("returned-findings", review.summary)
  if (review.passed) return false
  const scope = finalReviewRepairScope(mission, review)
  if (!scope) {
    await save(
      "returned-findings",
      "The findings name no task of the plan, so no repair starts here; the task reviews and the final review decide.",
    )
    return false
  }
  await requestRepair(
    `What ${ids} returned names blocking defects that are still open: ${review.findings.join("; ")}`,
    scope,
  )
  return true
}
