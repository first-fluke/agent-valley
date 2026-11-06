import { fixture, plan } from "./goal-supervision.fixture"
import type { OperatingRun } from "./operations"

export const operatorCancellation =
  "Operator stopped the order. Its checks and worktree were retained; repair any interrupted effects before resuming with --retry."

export function routingCancellationFixture() {
  const { mission } = fixture()
  mission.plan = structuredClone(plan)
  mission.tasks = [{ id: "onboarding", reviewerId: "reviewer", status: "pending", attempts: 2 }]
  mission.availableAgents = ["codex", "qwen", "opencode"]
  mission.operatingPolicy = {
    memory: true,
    reviewVendor: "prefer",
    readyActors: mission.availableAgents,
    routing: {
      minSamples: 3,
      minSuccessRate: 0.8,
      candidates: [
        { actorType: "codex", inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
        { actorType: "qwen", inputPerMillionUsd: 2, outputPerMillionUsd: 2 },
        { actorType: "opencode", inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
      ],
    },
  }
  mission.execution = { startedAt: "2026-11-08T04:47:06.195Z", runsStarted: 8, retries: 1 }
  const run: OperatingRun = {
    runId: "interrupted-opencode",
    taskId: "onboarding",
    actorId: "worker",
    actorType: "opencode",
    stage: "work",
    startedAt: "2026-11-08T05:00:28.032Z",
    finishedAt: "2026-11-08T05:12:33.687Z",
    elapsedMs: 725_655,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    outcome: "failed",
    executionState: "settled",
    executionRecovery: "local-process",
  }
  mission.operations = {
    runs: [run],
    reviewDecisions: [],
    routingEvidence: [
      { actorType: "codex", samples: 3, successes: 0, totalCostUsd: 1, successfulDeliverableCostUsd: null },
      { actorType: "qwen", samples: 3, successes: 2, totalCostUsd: 1, successfulDeliverableCostUsd: 0.5 },
      { actorType: "opencode", samples: 2, successes: 0, totalCostUsd: 1, successfulDeliverableCostUsd: null },
    ],
  }
  mission.history = [
    {
      at: "2026-11-08T05:00:27.694Z",
      stage: "work",
      taskId: "onboarding",
      message: "Running onboarding with worker, attempt 1.",
    },
    {
      at: run.startedAt,
      stage: "oma-dispatch",
      taskId: run.taskId,
      message: JSON.stringify({ attemptId: run.runId, actorId: run.actorId, actorType: run.actorType }),
    },
    { at: "2026-11-08T05:12:35.010Z", stage: "paused", message: operatorCancellation },
    { at: "2026-11-08T05:21:11.948Z", stage: "operator-intervention", message: "Resumed the same goal." },
  ]
  const worker = mission.personas.find((actor) => actor.id === "worker")
  if (!worker) throw new Error("Expected the saved worker")
  return { mission, run, worker }
}
