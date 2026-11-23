import { describe, expect, it } from "vitest"
import type { OperatingRun } from "./operations"
import { routeEvidence, selectWorkActor } from "./routing"
import { routingCancellationFixture } from "./routing-cancellation.fixture"

const TURN = "Repairing on the route whose rejected delivery is oldest; review rejected every configured route."
const CHIEF = "Every configured routing candidate failed this task"

/** Two ready routes in the first authorized repair round; review rejected the delivery of qwen. */
function twoRoutes() {
  const value = routingCancellationFixture()
  const { mission } = value
  const routing = mission.operatingPolicy?.routing
  const state = mission.tasks[0]
  if (!routing || !mission.operatingPolicy || !state) throw new Error("Expected the saved routing policy and task")
  mission.maxRepairs = 2
  mission.operatingPolicy.readyActors = ["codex", "qwen"]
  routing.candidates = [
    { actorType: "codex", inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
    { actorType: "qwen", inputPerMillionUsd: 2, outputPerMillionUsd: 2 },
  ]
  state.repairRound = 1
  const rejected = (runId: string, actorType: string, minute: number): OperatingRun => ({
    ...value.run,
    runId,
    actorType,
    startedAt: `2026-11-08T06:${minute}:00Z`,
    finishedAt: `2026-11-08T06:${minute + 5}:00Z`,
    outcome: "rejected",
    evidence: "Review rejected the delivery",
  })
  mission.operations?.runs.push(rejected("qwen-rejected", "qwen", 10))
  return { ...value, state, rejected }
}

describe("repair after review rejected every configured route", () => {
  // Regression: an integration task alternated between two routes. After each pair of rejections dispatch
  // stopped with "Every configured routing candidate failed this task" and a Chief recovery round only
  // restated the review, so the task spent two of the mission's twelve recovery rounds on routing.
  it("takes turns between the routes without a Chief decision while local repair budget remains", () => {
    const value = twoRoutes()
    value.mission.operations?.runs.push(value.rejected("codex-rejected", "codex", 20))
    const before = structuredClone(value.mission)
    const evidence = routeEvidence(value.mission)
    const first = selectWorkActor(value.mission, value.worker, "onboarding")
    expect(first.actor).toMatchObject({ id: "worker", agentType: "qwen" })
    expect(first.reason).toBe(TURN)
    expect(routeEvidence(value.mission)).toEqual(evidence)
    expect(value.mission).toEqual(before)

    value.mission.operations?.runs.push(value.rejected("qwen-rejected-again", "qwen", 30))
    value.state.repairRound = 2
    const second = selectWorkActor(value.mission, value.worker, "onboarding")
    expect(second.actor.agentType).toBe("codex")
    expect(second.reason).toBe(TURN)
  })

  it("keeps the Chief decision path when a route could not finish its run", () => {
    const value = twoRoutes()
    value.mission.operations?.runs.push({ ...value.rejected("codex-failed", "codex", 20), outcome: "failed" })
    expect(() => selectWorkActor(value.mission, value.worker, "onboarding")).toThrow(CHIEF)
  })

  it("keeps the Chief decision path outside the authorized repair rounds and for a finished task", () => {
    const spent = twoRoutes()
    spent.mission.operations?.runs.push(spent.rejected("codex-rejected", "codex", 20))
    spent.state.repairRound = spent.mission.maxRepairs + 1
    expect(() => selectWorkActor(spent.mission, spent.worker, "onboarding")).toThrow(CHIEF)
    spent.state.repairRound = 0
    expect(() => selectWorkActor(spent.mission, spent.worker, "onboarding")).toThrow(CHIEF)
    spent.state.repairRound = 1
    spent.state.status = "completed"
    expect(() => selectWorkActor(spent.mission, spent.worker, "onboarding")).toThrow(CHIEF)
  })
})
