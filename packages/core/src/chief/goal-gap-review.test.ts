import { describe, expect, it, vi } from "vitest"
import { MissionPause } from "./execution"
import { finalWaveAhead, reviewGoalGaps } from "./goal-gap-review"
import { brief, fixture } from "./goal-supervision.fixture"
import { goalGapPrompt } from "./prompts"
import type { ChiefTask, ChiefTaskState, Mission } from "./types"

const task = (id: string, dependencies: string[] = []): ChiefTask => ({
  id,
  title: `Task ${id}`,
  personaId: "worker",
  instructions: `Deliver ${id}.`,
  acceptance: [`${id} is delivered.`],
  dependencies,
})
const done = (id: string): ChiefTaskState => ({
  id,
  reviewerId: "reviewer",
  status: "completed",
  attempts: 1,
  output: `${id} delivered.`,
  review: { passed: true, summary: "Inspected.", findings: [] },
  fingerprint: "delivered",
})
const pending = (id: string): ChiefTaskState => ({ id, reviewerId: "reviewer", status: "pending", attempts: 0 })

/** contract -> lane -> (integrate, qa): the lane has delivered, the final wave has not started. */
function beforeFinalWave(): Mission {
  const { mission } = fixture()
  mission.goalBrief = brief
  mission.plan = {
    tasks: [task("contract"), task("lane", ["contract"]), task("integrate", ["lane"]), task("qa", ["lane"])],
  }
  mission.tasks = [done("contract"), done("lane"), pending("integrate"), pending("qa")]
  return mission
}

function context(mission: Mission, answer: () => Promise<string>) {
  const requestRecovery = vi.fn(async (_reason: string) => {})
  const run = vi.fn(async () => answer())
  return {
    requestRecovery,
    run,
    context: {
      mission,
      run: run as never,
      persona: (id: string) => mission.personas.find((entry) => entry.id === id) ?? (mission.personas[0] as never),
      save: async (stage: string, message: string) => {
        mission.history.push({ at: "2026-11-19T00:00:00.000Z", stage, message })
      },
      requestRecovery,
      protectedFailure: () => false,
      checkAbort: () => {},
    },
  }
}
const on = { AV_GOAL_GAP_REVIEW: "1" }
const gaps = JSON.stringify({
  passed: false,
  summary: "The command path supplies no endpoint facts.",
  findings: [
    "src/exec/context.rs:36 always supplies an empty fact list; the goal asks for classification of a real command.",
  ],
})
const covered = JSON.stringify({ passed: true, summary: "Every part of the goal has an owner.", findings: [] })

describe("the goal review before the final wave", () => {
  // Regression: a ten-hour mission learned at its final review that no task wired the production path,
  // six hours after its QA task had written the same gap down as a follow-up.
  it("is due only right before a final wave that has not started", () => {
    const mission = beforeFinalWave()
    expect(finalWaveAhead(mission)?.map((entry) => entry.id)).toEqual(["integrate", "qa"])

    const earlier = beforeFinalWave()
    earlier.tasks = [done("contract"), pending("lane"), pending("integrate"), pending("qa")]
    expect(finalWaveAhead(earlier)).toBeUndefined()

    const repairing = beforeFinalWave()
    repairing.tasks = [done("contract"), done("lane"), { ...pending("integrate"), attempts: 2 }, done("qa")]
    expect(finalWaveAhead(repairing)).toBeUndefined()

    const first = beforeFinalWave()
    first.tasks = first.tasks.map((state) => pending(state.id))
    expect(finalWaveAhead(first)).toBeUndefined()
  })

  it("asks the Chief for recovery with the findings and records the review", async () => {
    const mission = beforeFinalWave()
    const { context: input, requestRecovery, run } = context(mission, async () => gaps)
    expect(await reviewGoalGaps(input, on)).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
    expect(requestRecovery).toHaveBeenCalledTimes(1)
    expect(requestRecovery.mock.calls[0]?.[0]).toContain("src/exec/context.rs:36")
    expect(requestRecovery.mock.calls[0]?.[0]).toContain("integrate, qa")
    expect(mission.goalGapReviews?.[0]?.verdict).toBe("gaps")
    // The same standing is not reviewed twice, for example after a recovery that kept the plan.
    expect(await reviewGoalGaps(input, on)).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
  })

  // Regression: a goal that capped its own task count left no plan that also added one task per finding;
  // the Chief stopped, and the resumed mission started its final wave with the findings unowned.
  it("asks for recovery again when the Chief stopped on the findings and the mission is resumed", async () => {
    const mission = beforeFinalWave()
    const { context: input, requestRecovery, run } = context(mission, async () => gaps)
    expect(await reviewGoalGaps(input, on)).toBe(true)
    mission.supervision?.decisions.push({
      round: 1,
      at: new Date().toISOString(),
      action: "stop",
      reason: "No plan meets the task limit.",
      fingerprint: "delivered",
    })
    expect(await reviewGoalGaps(input, on)).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
    expect(requestRecovery).toHaveBeenCalledTimes(2)
    const reason = requestRecovery.mock.calls[1]?.[0] ?? ""
    expect(reason).toContain("src/exec/context.rs:36")
    expect(reason).toContain("group parts into fewer tasks")
    expect(reason).toContain("never a reason to stop")
    mission.supervision?.decisions.push({
      round: 2,
      at: new Date().toISOString(),
      action: "repair",
      reason: "The finding does not hold.",
      fingerprint: "delivered",
    })
    expect(await reviewGoalGaps(input, on)).toBe(false)
    expect(requestRecovery).toHaveBeenCalledTimes(2)
  })

  it("starts the final wave when the goal is covered, when disabled and when the review gives no verdict", async () => {
    const coveredMission = beforeFinalWave()
    const first = context(coveredMission, async () => covered)
    expect(await reviewGoalGaps(first.context, on)).toBe(false)
    expect(first.requestRecovery).not.toHaveBeenCalled()
    expect(coveredMission.goalGapReviews?.[0]?.verdict).toBe("covered")

    const off = context(beforeFinalWave(), async () => gaps)
    expect(await reviewGoalGaps(off.context, {})).toBe(false)
    expect(off.run).not.toHaveBeenCalled()

    const silent = beforeFinalWave()
    const prose = context(silent, async () => "I looked at the files and they seem fine.")
    expect(await reviewGoalGaps(prose.context, on)).toBe(false)
    expect(prose.requestRecovery).not.toHaveBeenCalled()
    expect(silent.goalGapReviews?.[0]?.verdict).toBe("no-verdict")
  })

  it("does not swallow a pause", async () => {
    const paused = context(beforeFinalWave(), async () => {
      throw new MissionPause("Operator stopped mission supervision.", "interrupted")
    })
    await expect(reviewGoalGaps(paused.context, on)).rejects.toBeInstanceOf(MissionPause)
  })

  it("tells the Chief which tasks remain and what not to report", () => {
    const mission = beforeFinalWave()
    const prompt = goalGapPrompt(mission, finalWaveAhead(mission) ?? [])
    expect(prompt).toContain("goal review before the final wave")
    expect(prompt).toContain('"remainingTasks":[{"id":"integrate"')
    expect(prompt).toContain("that a remaining task is assigned to produce")
    expect(prompt).not.toContain('"operations"')
  })
})
