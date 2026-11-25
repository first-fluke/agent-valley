import { describe, expect, it, vi } from "vitest"
import { MissionPause } from "./execution"
import { reviewGoalGaps } from "./goal-gap-review"
import { brief, fixture } from "./goal-supervision.fixture"
import { returnedFindingsPrompt } from "./prompts"
import { finalWaveReturned, reviewReturnedFindings } from "./returned-findings-review"
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
const returned = (id: string, output: string): ChiefTaskState => ({
  id,
  reviewerId: "reviewer",
  status: "reviewing",
  attempts: 1,
  output,
})

/** contract -> lane -> (integrate, qa): the final wave has returned and is integrated, nothing is reviewed. */
function finalWaveBack(): { mission: Mission; wave: ChiefTask[] } {
  const { mission } = fixture()
  mission.goalBrief = brief
  const wave = [task("integrate", ["lane"]), task("qa", ["lane"])]
  mission.plan = { tasks: [task("contract"), task("lane", ["contract"]), ...wave] }
  mission.tasks = [
    done("contract"),
    done("lane"),
    returned("integrate", "Marked the read-bytes requirement complete."),
    returned("qa", "BLOCKER: the lane test never reads from disk, so a broken reader passes."),
  ]
  return { mission, wave }
}

function context(mission: Mission, answer: () => Promise<string>) {
  const requestRepair = vi.fn(async (_reason: string, _scope?: string | ReadonlySet<string> | null) => {})
  const run = vi.fn(async () => answer())
  return {
    requestRepair,
    run,
    context: {
      mission,
      run: run as never,
      persona: (id: string) => mission.personas.find((entry) => entry.id === id) ?? (mission.personas[0] as never),
      save: async (stage: string, message: string) => {
        mission.history.push({ at: "2026-11-22T00:00:00.000Z", stage, message })
      },
      requestRepair,
      protectedFailure: () => false,
      checkAbort: () => {},
    },
  }
}
const open = JSON.stringify({
  passed: false,
  summary: "QA names a blocking defect that is still open.",
  findings: ["lane: tests/meter/tree.c:40 never reads from disk; read the written bytes back and assert them."],
})
const nothing = JSON.stringify({ passed: true, summary: "No returned output names an open blocker.", findings: [] })

describe("the Chief's look at what the final wave returned", () => {
  // Regression: QA ran beside the integration task and recorded two blocking defects in a lane's tests. Its
  // review passed, and the lane was repaired only after a 53-minute integrated check, a verification and a
  // rejected final review.
  it("is due only when the returned tasks are the whole rest of the mission", () => {
    const { mission, wave } = finalWaveBack()
    expect(finalWaveReturned(mission, wave)).toBe(true)
    expect(finalWaveReturned(mission, [wave[0] as ChiefTask])).toBe(false)

    const running = finalWaveBack()
    delete (running.mission.tasks[3] as ChiefTaskState).output
    expect(finalWaveReturned(running.mission, running.wave)).toBe(false)

    const lanes = finalWaveBack()
    lanes.mission.tasks[1] = returned("lane", "Lane delivered.")
    expect(finalWaveReturned(lanes.mission, [task("lane", ["contract"])])).toBe(false)
  })

  it("sends the owning task and its dependents to repair before the integrated check", async () => {
    const { mission, wave } = finalWaveBack()
    const { context: ctx, requestRepair, run } = context(mission, async () => open)

    expect(await reviewReturnedFindings(ctx, wave)).toBe(true)

    expect(run).toHaveBeenCalledOnce()
    const [reason, scope] = requestRepair.mock.calls[0] ?? []
    expect(reason).toContain("never reads from disk")
    expect([...(scope as ReadonlySet<string>)].sort()).toEqual(["integrate", "lane", "qa"])
    expect(mission.goalGapReviews?.at(-1)).toMatchObject({ verdict: "gaps", key: "returned:integrate#1,qa#1" })
    // The same deliveries are not read twice, for example after a restart.
    expect(await reviewReturnedFindings(ctx, wave)).toBe(false)
    expect(run).toHaveBeenCalledOnce()
  })

  it("lets the wave go on when no returned output names an open blocker", async () => {
    const { mission, wave } = finalWaveBack()
    const { context: ctx, requestRepair } = context(mission, async () => nothing)

    expect(await reviewReturnedFindings(ctx, wave)).toBe(false)
    expect(requestRepair).not.toHaveBeenCalled()
    expect(mission.goalGapReviews?.at(-1)?.verdict).toBe("covered")
  })

  it("starts no repair for findings that name no task of the plan", async () => {
    const { mission, wave } = finalWaveBack()
    const unowned = JSON.stringify({ passed: false, summary: "Open.", findings: ["Some test is weak."] })
    const { context: ctx, requestRepair } = context(mission, async () => unowned)

    expect(await reviewReturnedFindings(ctx, wave)).toBe(false)
    expect(requestRepair).not.toHaveBeenCalled()
  })

  it("is an early look, not a gate: without a verdict the wave goes on", async () => {
    const { mission, wave } = finalWaveBack()
    const { context: ctx, requestRepair } = context(mission, async () => "not json")

    expect(await reviewReturnedFindings(ctx, wave)).toBe(false)
    expect(requestRepair).not.toHaveBeenCalled()
    expect(mission.goalGapReviews?.at(-1)?.verdict).toBe("no-verdict")

    const paused = finalWaveBack()
    const stop = context(paused.mission, async () => {
      throw new MissionPause("Usage exhausted.", "budget")
    })
    await expect(reviewReturnedFindings(stop.context, paused.wave)).rejects.toBeInstanceOf(MissionPause)
  })

  it("stops after two looks", async () => {
    const { mission, wave } = finalWaveBack()
    const { context: ctx, run } = context(mission, async () => nothing)

    mission.goalGapReviews = ["returned:a#1", "returned:b#1"].map((key) => ({
      at: "2026-11-22T00:00:00.000Z",
      key,
      verdict: "covered" as const,
      summary: "Earlier look.",
      findings: [],
    }))
    expect(await reviewReturnedFindings(ctx, wave)).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it("does not use up the goal reviews taken before a final wave", async () => {
    const { mission } = fixture()
    mission.goalBrief = brief
    mission.plan = { tasks: [task("contract"), task("integrate", ["contract"])] }
    mission.tasks = [done("contract"), { id: "integrate", reviewerId: "reviewer", status: "pending", attempts: 0 }]
    mission.goalGapReviews = ["returned:a#1", "returned:b#1"].map((key) => ({
      at: "2026-11-22T00:00:00.000Z",
      key,
      verdict: "covered" as const,
      summary: "Earlier look.",
      findings: [],
    }))
    const run = vi.fn(async () => nothing)
    const reviewed = await reviewGoalGaps({
      ...context(mission, async () => nothing).context,
      run: run as never,
      requestRecovery: vi.fn() as never,
    })
    expect(reviewed).toBe(false)
    expect(run).toHaveBeenCalledOnce()
  })

  it("asks only for blockers the returned outputs name and for the owning task id", () => {
    const { mission, wave } = finalWaveBack()
    const prompt = returnedFindingsPrompt(mission, wave)
    expect(prompt).toContain("Do not search for further defects")
    expect(prompt).toContain("starts with the id of the plan task that owns the file to repair")
    expect(prompt).toContain("BLOCKER: the lane test never reads from disk")
  })
})
