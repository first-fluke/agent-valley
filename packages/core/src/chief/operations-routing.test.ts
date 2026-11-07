import { describe, expect, it } from "vitest"
import { fixture, plan } from "./goal-supervision.fixture"
import type { ChiefOperatingPolicy, ChiefOperations, OperatingRun } from "./operations"
import { operationsEvidence, operationsReportLines } from "./operations-report"
import { selectTaskReviewer } from "./review-routing"
import { routeEvidence, routeKey, selectWorkActor, workActorCandidates } from "./routing"
import { finalCriteria, missionSchema, parseFinalReview } from "./schemas"
import { finishOperatingRun, startOperatingRun } from "./usage"

function setup() {
  const mission = fixture().mission
  mission.availableAgents = ["codex", "claude", "cursor"]
  mission.availableSkills = []
  const operatingPolicy: ChiefOperatingPolicy = {
    reviewVendor: "prefer",
    memory: true,
    readyActors: ["codex", "claude", "cursor"],
    routing: {
      minSamples: 3,
      minSuccessRate: 0.8,
      candidates: [
        { actorType: "claude", model: "careful", inputPerMillionUsd: 3, outputPerMillionUsd: 6 },
        { actorType: "codex", model: "cheap", inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
      ],
    },
  }
  const operations: ChiefOperations = { runs: [], routingEvidence: [], reviewDecisions: [] }
  return Object.assign(mission, { operatingPolicy, operations })
}
function fixtureActor(mission: import("./types").Mission, id: string) {
  const result = mission.personas.find((entry) => entry.id === id)
  if (!result) throw new Error(`Fixture Actor ${id} is missing`)
  return result
}
function run(overrides: Partial<OperatingRun> = {}): OperatingRun {
  return {
    runId: "real-attempt",
    taskId: "onboarding",
    stage: "work",
    actorId: "worker",
    actorType: "codex",
    model: "cheap",
    startedAt: "2026-10-03T00:00:00Z",
    finishedAt: "2026-10-03T00:00:01Z",
    elapsedMs: 1000,
    inputTokens: 1000,
    outputTokens: 2000,
    costUsd: 0.005,
    outcome: "passed",
    ...overrides,
  }
}

describe("measured work routing", () => {
  it("filters compatibility before existing price and success ranking", () => {
    const mission = setup()
    const worker = fixtureActor(mission, "worker")
    expect(workActorCandidates(mission, worker)).toHaveLength(2)
    const compatible = new Set([routeKey({ actorType: "claude", model: "careful" })])
    expect(selectWorkActor(mission, worker, "onboarding", compatible).actor.agentType).toBe("claude")
    expect(() => selectWorkActor(mission, worker, "onboarding", new Set())).toThrow("no ready work candidate")
  })
  it("fails fixed Actor/model compatibility without silently rerouting", () => {
    const mission = setup()
    delete mission.availableAgents
    const worker = fixtureActor(mission, "worker")
    worker.model = "operator-model"
    expect(workActorCandidates(mission, worker)).toEqual([{ actorType: worker.agentType, model: "operator-model" }])
    expect(() => selectWorkActor(mission, worker, "onboarding", new Set())).toThrow("explicit Actors are not rerouted")
    delete worker.model
    expect(workActorCandidates(mission, worker, true)).toEqual([{ actorType: worker.agentType, model: undefined }])
    expect(() =>
      selectWorkActor(mission, worker, "onboarding", new Set([routeKey({ actorType: "claude", model: "careful" })])),
    ).toThrow("explicit Actors are not rerouted")
  })
  it("starts the lowest completely configured price while preserving the Chief choice", () => {
    const mission = setup()
    const worker = fixtureActor(mission, "worker")
    const selected = selectWorkActor(mission, worker, "onboarding")
    expect(selected.actor).toMatchObject({ id: "worker", agentType: "codex", model: "cheap" })
    expect(selected.reason).toContain("not a measured run cost")
    expect(worker.agentType).toBe("cursor")
    expect(selectWorkActor(mission, fixtureActor(mission, "chief"), "chief-task").actor).toBe(mission.personas[0])
  })
  it("chooses observed successful-deliverable cost over advertised price only after quality samples", () => {
    const mission = setup()
    mission.operations.routingEvidence = [
      {
        actorType: "codex",
        model: "cheap",
        samples: 4,
        successes: 4,
        totalCostUsd: 0.4,
        successfulDeliverableCostUsd: 0.1,
      },
      {
        actorType: "claude",
        model: "careful",
        samples: 4,
        successes: 4,
        totalCostUsd: 0.08,
        successfulDeliverableCostUsd: 0.02,
      },
    ]
    expect(selectWorkActor(mission, fixtureActor(mission, "worker"), "onboarding").actor.agentType).toBe("claude")
    const poor = mission.operations.routingEvidence.find((route) => route.actorType === "claude")
    if (!poor) throw new Error("Missing fixture route")
    poor.successes = 1
    expect(selectWorkActor(mission, fixtureActor(mission, "worker"), "onboarding").actor.agentType).toBe("codex")
  })
  it("escalates from an actually rejected route once and fails honestly after exhausting candidates", () => {
    const mission = setup()
    mission.operations.runs.push(run({ outcome: "rejected" }))
    expect(selectWorkActor(mission, fixtureActor(mission, "worker"), "onboarding").actor.agentType).toBe("claude")
    mission.operations.runs.push(run({ runId: "second", actorType: "claude", model: "careful", outcome: "failed" }))
    expect(() => selectWorkActor(mission, fixtureActor(mission, "worker"), "onboarding")).toThrow(
      "Every configured routing candidate failed",
    )
  })
  it("never substitutes an explicit custom-roster work model or an unavailable candidate", () => {
    const mission = setup()
    delete mission.availableAgents
    fixtureActor(mission, "worker").model = "operator-worker-model"
    expect(selectWorkActor(mission, fixtureActor(mission, "worker"), "onboarding").actor.model).toBe(
      "operator-worker-model",
    )
    delete fixtureActor(mission, "worker").model
    mission.operatingPolicy.readyActors = ["cursor"]
    expect(() => selectWorkActor(mission, fixtureActor(mission, "worker"), "onboarding")).toThrow(
      "No configured work routing candidate is ready",
    )
  })
  it("includes failed work in cost per success and never turns unknown usage into zero cost", () => {
    const mission = setup()
    mission.operations.runs.push(run(), run({ runId: "rejection", outcome: "rejected", costUsd: 0.015 }))
    expect(routeEvidence(mission)[0]).toMatchObject({ samples: 2, successes: 1, successfulDeliverableCostUsd: 0.02 })
    mission.operations.runs.push(run({ runId: "unknown", outcome: "failed", costUsd: null, inputTokens: null }))
    expect(routeEvidence(mission)[0]).toMatchObject({
      samples: 3,
      totalCostUsd: null,
      successfulDeliverableCostUsd: null,
    })
    expect(operationsEvidence(mission)).toMatchObject({ unknownCostRuns: 1, totalEstimatedCostUsd: null })
  })
})

describe("windowed route evidence", () => {
  function history(mission: ReturnType<typeof setup>, count: number, outcome: OperatingRun["outcome"], offset = 0) {
    for (let index = 0; index < count; index += 1)
      mission.operations.runs.push(
        run({
          runId: `codex-${outcome}-${offset + index}`,
          taskId: "earlier-task",
          outcome,
          startedAt: new Date(Date.UTC(2026, 9, 4, 0, offset + index)).toISOString(),
          finishedAt: new Date(Date.UTC(2026, 9, 4, 0, offset + index, 1)).toISOString(),
        }),
      )
  }

  it("recovers a route whose failures fell out of the evidence window and keeps lifetime totals", () => {
    const mission = setup()
    history(mission, 12, "failed")
    history(mission, 10, "passed", 12)
    const evidence = routeEvidence(mission).find((entry) => entry.actorType === "codex")
    expect(evidence).toMatchObject({ samples: 22, successes: 10 })
    expect(evidence?.recent).toHaveLength(10)
    expect(evidence?.recent?.every((entry) => entry.outcome === "passed")).toBe(true)
    expect(selectWorkActor(mission, fixtureActor(mission, "worker"), "onboarding").actor.agentType).toBe("codex")
  })

  it("stops preferring a route whose newest window fails even when its lifetime rate qualifies", () => {
    const mission = setup()
    history(mission, 40, "passed")
    history(mission, 10, "failed", 40)
    const evidence = routeEvidence(mission).find((entry) => entry.actorType === "codex")
    expect((evidence?.successes ?? 0) / (evidence?.samples ?? 1)).toBeGreaterThanOrEqual(0.8)
    expect(evidence?.recent?.every((entry) => entry.outcome === "failed")).toBe(true)
    expect(selectWorkActor(mission, fixtureActor(mission, "worker"), "onboarding").actor.agentType).toBe("claude")
  })

  it("uses the configured window instead of the default ten samples", () => {
    const mission = setup()
    if (mission.operatingPolicy.routing) mission.operatingPolicy.routing.evidenceWindow = 3
    history(mission, 5, "failed")
    history(mission, 3, "passed", 5)
    expect(routeEvidence(mission)[0]?.recent).toHaveLength(3)
    expect(selectWorkActor(mission, fixtureActor(mission, "worker"), "onboarding").actor.agentType).toBe("codex")
  })

  it("keeps the lifetime rate for a saved record that has no per-run history", () => {
    const mission = setup()
    mission.operations.routingEvidence = [
      {
        actorType: "codex",
        model: "cheap",
        samples: 26,
        successes: 17,
        totalCostUsd: 1,
        successfulDeliverableCostUsd: 0.05,
      },
    ]
    history(mission, 1, "passed")
    expect(routeEvidence(mission)[0]).toMatchObject({ samples: 27, successes: 18 })
    expect(selectWorkActor(mission, fixtureActor(mission, "worker"), "onboarding").actor.agentType).toBe("claude")
  })
})

describe("actual run usage", () => {
  it("records actual adapter tokens, elapsed timestamps and configured-price estimates without approving work", () => {
    const mission = setup()
    const actor = { ...fixtureActor(mission, "worker"), agentType: "codex", model: "cheap" }
    const attempt = {
      id: "usage-run",
      issueId: mission.id,
      workspacePath: mission.workspace.path,
      startedAt: "2026-10-03T00:00:00Z",
      finishedAt: "2026-10-03T00:00:02Z",
      exitCode: 0,
      agentOutput: "actual result",
      tokenUsage: { input: 1000, output: 2000, model: "cheap" },
    }
    const entry = startOperatingRun(mission, actor, attempt, "work", "onboarding")
    finishOperatingRun(mission, entry, attempt)
    expect(entry).toMatchObject({
      inputTokens: 1000,
      outputTokens: 2000,
      elapsedMs: 2000,
      costUsd: 0.005,
      outcome: "pending",
    })
    finishOperatingRun(
      mission,
      entry,
      { ...attempt, tokenUsage: { ...attempt.tokenUsage, model: "different-model" } },
      true,
    )
    expect(entry.outcome).toBe("failed")
    // A changed reported model cannot retain the prior candidate's price estimate.
    expect(entry.costUsd).toBeNull()
  })
})

describe("vendor-independent task review", () => {
  it("injects another ready vendor based on actual routed work rather than the original assignment", () => {
    const mission = setup()
    mission.personas.forEach((actor) => {
      actor.agentType = "claude"
    })
    mission.operations.runs.push(run({ actorType: "claude", model: "careful", outcome: "pending" }))
    const state = { id: "onboarding", reviewerId: "reviewer", status: "reviewing" as const, attempts: 1 }
    const reviewer = selectTaskReviewer(mission, plan.tasks[0] as import("./types").ChiefTask, state)
    expect(reviewer.agentType).toBe("codex")
    expect(reviewer.id).not.toBe("worker")
    expect(state.reviewerId).toBe(reviewer.id)
    expect(mission.operations.reviewDecisions[0]).toMatchObject({
      workerActorType: "claude",
      reviewerActorType: "codex",
      crossVendor: true,
    })
  })
  it("discloses same-vendor fallback and makes required review fail actionably", () => {
    const mission = setup()
    mission.personas.forEach((actor) => {
      actor.agentType = "claude"
    })
    mission.operatingPolicy.readyActors = ["claude"]
    const state = { id: "onboarding", reviewerId: "reviewer", status: "reviewing" as const, attempts: 1 }
    selectTaskReviewer(mission, plan.tasks[0] as import("./types").ChiefTask, state)
    expect(operationsReportLines(mission).join("\n")).toContain("동일 vendor fallback")
    mission.operatingPolicy.reviewVendor = "require"
    expect(() => selectTaskReviewer(mission, plan.tasks[0] as import("./types").ChiefTask, state)).toThrow(
      "Install/login another Actor CLI",
    )
  })
})

describe("business completion evidence", () => {
  it("adds fixed business criteria and rejects model claims when actual metric measurements are absent", () => {
    const mission = fixture().mission
    mission.goalBrief = { interpretation: "Improve activation", assumptions: [], successCriteria: ["Usable flow"] }
    mission.operatingPolicy = {
      reviewVendor: "prefer",
      memory: true,
      metricTargets: [{ name: "activation", direction: "increase", target: 40 }],
    }
    expect(finalCriteria(mission)).toEqual(["Usable flow", "metric:activation:increase:40"])
    const review = parseFinalReview(
      JSON.stringify({
        passed: true,
        summary: "Model claimed success",
        findings: [],
        criteria: finalCriteria(mission).map((criterion) => ({
          criterion,
          passed: true,
          evidence: "Model claim only",
        })),
      }),
      mission,
    )
    expect(review.passed).toBe(false)
    expect(review.findings.join(" ")).toContain("No comparable recorded current observation")
  })
  it("keeps legacy missions valid without introducing new required fields", () => {
    expect(missionSchema.parse(fixture().mission).operatingPolicy).toBeUndefined()
  })
})
