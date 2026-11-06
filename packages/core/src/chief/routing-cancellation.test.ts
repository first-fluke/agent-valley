import { describe, expect, it } from "vitest"
import { operationsEvidence } from "./operations-report"
import { routeEvidence, selectWorkActor } from "./routing"
import { routingCancellationFixture } from "./routing-cancellation.fixture"

describe("routing after a proven native operator cancellation", () => {
  it("keeps the only eligible saved route after SIGINT without changing spent usage or task attempts", () => {
    const { mission, worker } = routingCancellationFixture()
    const before = structuredClone(mission)

    expect(routeEvidence(mission).find((route) => route.actorType === "opencode")).toMatchObject({
      samples: 2,
      successes: 0,
      totalCostUsd: null,
      successfulDeliverableCostUsd: null,
    })
    expect(selectWorkActor(mission, worker, "onboarding").actor.agentType).toBe("opencode")
    expect(operationsEvidence(mission)).toMatchObject({
      measuredRuns: 1,
      unknownCostRuns: 1,
      totalEstimatedCostUsd: null,
    })
    expect(mission).toEqual(before)
  })

  it("does not blacklist a cancelled route for the same task even before enough quality samples exist", () => {
    const { mission, worker } = routingCancellationFixture()
    if (mission.operatingPolicy?.routing) mission.operatingPolicy.routing.minSamples = 100
    expect(selectWorkActor(mission, worker, "onboarding").actor.agentType).toBe("opencode")
  })

  it.each(["running", "unknown"] as const)(
    "keeps historical cancellation neutral when a later report has an unrelated %s outcome",
    (executionState) => {
      const { mission, run, worker } = routingCancellationFixture()
      mission.operations?.runs.push({
        ...run,
        runId: "later-report",
        stage: "report",
        actorId: mission.chiefId,
        startedAt: "2026-11-08T05:26:00Z",
        finishedAt: null,
        outcome: "pending",
        executionState,
      })
      expect(routeEvidence(mission).find((route) => route.actorType === "opencode")?.samples).toBe(2)
      expect(selectWorkActor(mission, worker, "onboarding").actor.agentType).toBe("opencode")
    },
  )

  it("retains known cancelled cost in successful-deliverable cost without adding a quality sample", () => {
    const { mission, run } = routingCancellationFixture()
    if (mission.operations)
      mission.operations.routingEvidence = [
        { actorType: "opencode", samples: 2, successes: 2, totalCostUsd: 0.2, successfulDeliverableCostUsd: 0.1 },
      ]
    run.costUsd = 0.25
    expect(routeEvidence(mission)[0]).toMatchObject({
      samples: 2,
      successes: 2,
      totalCostUsd: 0.45,
      successfulDeliverableCostUsd: 0.225,
    })
    expect(operationsEvidence(mission).knownEstimatedCostUsd).toBe(0.25)
  })

  it.each(["Agent timed out after 1800s", "Provider returned 503 overloaded", "Native process exited with code 1"])(
    "retains explicit native failure evidence even if the operator stopped immediately afterward: %s",
    (evidence) => {
      const { mission, run, worker } = routingCancellationFixture()
      run.evidence = evidence
      expect(routeEvidence(mission).find((route) => route.actorType === "opencode")?.samples).toBe(3)
      expect(selectWorkActor(mission, worker, "onboarding").actor.agentType).toBe("qwen")
    },
  )

  it.each([
    "generic-interruption",
    "nonlocal",
    "unknown",
    "running",
    "no-finish",
    "after-pause",
    "wrong-actor",
    "missing-dispatch",
    "wrong-dispatch-id",
    "returned-output",
    "review-verdict",
    "recovery-before-stop",
    "ambiguous-run",
    "rejected",
    "external-effect",
    "overlapping-unknown",
    "invalid-run-date",
  ])("keeps failed quality samples when cancellation proof is incomplete: %s", (condition) => {
    const { mission, run, worker } = routingCancellationFixture()
    const pause = mission.history[2]
    const dispatch = mission.history[1]
    if (condition === "generic-interruption" && pause) pause.message = "Interrupted"
    if (condition === "nonlocal") run.executionRecovery = "reconcile"
    if (condition === "unknown") run.executionState = "unknown"
    if (condition === "running") run.executionState = "running"
    if (condition === "no-finish") run.finishedAt = null
    if (condition === "after-pause") run.finishedAt = "2026-11-08T05:12:36.000Z"
    if (condition === "wrong-actor") run.actorId = "unrelated-worker"
    if (condition === "missing-dispatch") mission.history.splice(0, 1)
    if (condition === "wrong-dispatch-id" && dispatch)
      dispatch.message = JSON.stringify({ attemptId: "another-run", actorId: run.actorId })
    if (condition === "returned-output" || condition === "review-verdict" || condition === "recovery-before-stop")
      mission.history.splice(2, 0, {
        at: "2026-11-08T05:12:34.000Z",
        stage: condition === "returned-output" ? "work" : condition === "review-verdict" ? "review" : "chief-recovery",
        taskId: run.taskId,
        message: "Native work already returned or failed before the later stop.",
      })
    if (condition === "ambiguous-run") mission.operations?.runs.push({ ...run, runId: "another-run" })
    if (condition === "rejected") run.outcome = "rejected"
    if (condition === "external-effect" && mission.tasks[0]) mission.tasks[0].effectState = "unknown"
    if (condition === "overlapping-unknown" || condition === "invalid-run-date")
      mission.operations?.runs.push({
        ...run,
        runId: "unresolved-overlap",
        stage: "report",
        startedAt: condition === "invalid-run-date" ? "unreadable" : "2026-11-08T05:01:00Z",
        executionState: "unknown",
        finishedAt: null,
        outcome: "pending",
      })

    expect(routeEvidence(mission).find((route) => route.actorType === "opencode")?.samples).toBeGreaterThanOrEqual(3)
    if (
      ["unknown", "running", "no-finish", "external-effect", "overlapping-unknown", "invalid-run-date"].includes(
        condition,
      )
    )
      expect(() => selectWorkActor(mission, worker, "onboarding")).toThrow(
        ["unknown", "running", "no-finish"].includes(condition)
          ? "Actor execution outcome is uncertain"
          : "minimum success rate",
      )
    else expect(selectWorkActor(mission, worker, "onboarding").actor.agentType).toBe("qwen")
  })

  it("retains an earlier actual failed route for this task after a later cancelled retry", () => {
    const { mission, run, worker } = routingCancellationFixture()
    if (mission.operatingPolicy?.routing) mission.operatingPolicy.routing.minSamples = 100
    mission.operations?.runs.unshift({
      ...run,
      runId: "real-failure",
      startedAt: "2026-11-08T04:40:00Z",
      finishedAt: "2026-11-08T04:41:00Z",
    })
    expect(selectWorkActor(mission, worker, "onboarding").actor.agentType).toBe("codex")
    expect(routeEvidence(mission).find((route) => route.actorType === "opencode")?.samples).toBe(3)
  })
})
