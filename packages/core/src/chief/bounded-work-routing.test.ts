import { describe, expect, it } from "vitest"
import { degradedWorkRoute } from "./bounded-work-routing"
import type { OperatingRun, RouteEvidence, RouteOutcome, RoutingCandidate } from "./operations"
import { operationsEvidence } from "./operations-report"
import { routeEvidence, routeKey, selectWorkActor } from "./routing"
import { routingCancellationFixture } from "./routing-cancellation.fixture"

function closedPool() {
  const value = routingCancellationFixture()
  const { mission } = value
  mission.maxRepairs = 2
  const state = mission.tasks[0]
  if (!state) throw new Error("Expected the same saved task")
  state.attempts = 4
  state.repairRound = 1
  state.review = {
    passed: false,
    summary: "JSON arrays do not parse",
    findings: ["Decode arrays before processing IPC"],
  }
  const rejection: OperatingRun = {
    ...value.run,
    runId: "actual-rejection",
    startedAt: "2026-11-08T05:47:00Z",
    finishedAt: "2026-11-08T06:17:00Z",
    elapsedMs: 1_800_000,
    outcome: "rejected",
    evidence: state.review.summary,
  }
  mission.operations?.runs.push(rejection)
  return { ...value, rejection, state }
}

function recordProbe(
  value: ReturnType<typeof closedPool>,
  selected: ReturnType<typeof selectWorkActor>,
  id: string,
  outcome: OperatingRun["outcome"] = "failed",
) {
  const run: OperatingRun = {
    ...value.rejection,
    runId: id,
    actorType: selected.actor.agentType,
    model: selected.actor.model,
    startedAt: "2026-11-08T06:30:00Z",
    finishedAt: "2026-11-08T06:31:00Z",
    outcome,
    routingReason: selected.reason,
  }
  value.mission.operations?.runs.push(run)
  return run
}

describe("bounded routing in a closed measured pool", () => {
  it("continues the actual same-task repair on the best measured fixed-pool route without changing its evidence or spent limits", () => {
    const { mission, worker } = closedPool()
    const before = structuredClone(mission)
    const evidence = routeEvidence(mission)
    const selected = selectWorkActor(mission, worker, "onboarding")
    expect(selected.actor).toMatchObject({ id: "worker", agentType: "qwen" })
    expect(selected.reason).toMatch(/^Bounded routing probe [a-f0-9]{64}: /)
    expect(selected.reason).toContain("below-threshold")
    expect(routeEvidence(mission)).toEqual(evidence)
    expect(mission).toEqual(before)
    expect(operationsEvidence(mission)).toMatchObject({
      measuredRuns: 2,
      unknownCostRuns: 2,
      totalEstimatedCostUsd: null,
    })
  })

  it("gives a genuinely new task its own bounded probe after the previous task was approved", () => {
    const value = closedPool()
    const first = selectWorkActor(value.mission, value.worker, "onboarding")
    recordProbe(value, first, "approved-work", "passed")
    value.state.status = "completed"
    const original = value.mission.plan?.tasks[0]
    if (!original || !value.mission.plan) throw new Error("Expected the saved plan")
    value.mission.plan.tasks.push({ ...original, id: "resident", title: "Resident service" })
    value.mission.tasks.push({ id: "resident", reviewerId: "reviewer", status: "running", attempts: 1 })
    const next = selectWorkActor(value.mission, value.worker, "resident")
    expect(next.actor.agentType).toBe("qwen")
    expect(next.reason).toMatch(/^Bounded routing probe /)
    expect(next.reason).not.toBe(first.reason)
  })

  it("prefers a fresh normally qualified route over a probe", () => {
    const { mission, worker } = closedPool()
    const qwen = mission.operations?.routingEvidence.find((entry) => entry.actorType === "qwen")
    if (!qwen) throw new Error("Expected the Qwen evidence")
    qwen.successes = 3
    expect(selectWorkActor(mission, worker, "onboarding").reason).not.toContain("Bounded routing probe")
  })

  it("can probe a fresh lower-quality route when the qualified route already failed this task", () => {
    const value = closedPool()
    const qwen = value.mission.operations?.routingEvidence.find((entry) => entry.actorType === "qwen")
    if (!qwen) throw new Error("Expected the Qwen evidence")
    Object.assign(qwen, { samples: 10, successes: 10 })
    value.mission.operations?.runs.push({ ...value.rejection, runId: "failed-qualified", actorType: "qwen" })
    const selected = selectWorkActor(value.mission, value.worker, "onboarding")
    expect(selected.actor.agentType).toBe("codex")
    expect(selected.reason).toContain("Bounded routing probe")
  })

  it("retains each native probe across restart and stop/retry without reopening failed routes", () => {
    const value = closedPool()
    const first = selectWorkActor(value.mission, value.worker, "onboarding")
    recordProbe(value, first, "qwen-probe")
    value.mission = structuredClone(value.mission)
    if (value.mission.execution) value.mission.execution.retries = 0
    value.mission.updatedAt = "2026-11-08T07:00:00Z"
    value.mission.supervision?.decisions.push({
      round: 1,
      at: value.mission.updatedAt,
      action: "stop",
      reason: "Stop",
      fingerprint: "same",
    })
    const second = selectWorkActor(value.mission, value.worker, "onboarding")
    expect(second.actor.agentType).toBe("codex")
    recordProbe(value, second, "codex-probe")
    expect(() => selectWorkActor(value.mission, value.worker, "onboarding")).toThrow(
      "Every configured routing candidate failed this task",
    )
    expect(
      value.mission.operations?.runs.filter((entry) => entry.routingReason?.startsWith("Bounded routing probe")),
    ).toHaveLength(2)
  })

  it("does not repeat an unreviewed completed native probe after restart", () => {
    const value = closedPool()
    recordProbe(value, selectWorkActor(value.mission, value.worker, "onboarding"), "unreviewed", "pending")
    expect(() => selectWorkActor(structuredClone(value.mission), value.worker, "onboarding")).toThrow(
      "unreviewed bounded routing probe",
    )
  })

  it("does not bypass the saved unreviewed probe when parallel successes qualify that vendor", () => {
    const value = closedPool()
    const probe = selectWorkActor(value.mission, value.worker, "onboarding")
    recordProbe(value, probe, "unreviewed", "pending")
    for (let index = 0; index < 3; index += 1)
      value.mission.operations?.runs.push({
        ...value.rejection,
        runId: `parallel-success-${index}`,
        taskId: `parallel-${index}`,
        actorType: "qwen",
        outcome: "passed",
        costUsd: 0.1,
      })
    const quality = routeEvidence(value.mission).find((entry) => entry.actorType === "qwen")
    expect((quality?.successes ?? 0) / (quality?.samples ?? 1)).toBeGreaterThanOrEqual(0.8)
    expect(() => selectWorkActor(structuredClone(value.mission), value.worker, "onboarding")).toThrow(
      "unreviewed bounded routing probe",
    )
    if (!value.mission.supervision) throw new Error("Expected Chief supervision")
    value.mission.supervision.rounds = 1
    value.mission.supervision.decisions.push({
      round: 1,
      at: "2026-11-08T07:00:00Z",
      action: "repair",
      taskId: "onboarding",
      reason: "The original output was lost; inspect and implement the retained finding",
      fingerprint: "same",
      instructions: "Reconcile the missing output",
    })
    expect(selectWorkActor(value.mission, value.worker, "onboarding").actor.agentType).toBe("qwen")
  })

  it.each(["repair", "reassign", "replan"] as const)(
    "allows one failed-route retry only after explicit Chief %s",
    (action) => {
      const value = closedPool()
      value.mission.operations?.runs.push(
        { ...value.rejection, runId: "qwen-failed", actorType: "qwen" },
        { ...value.rejection, runId: "codex-failed", actorType: "codex" },
      )
      expect(() => selectWorkActor(value.mission, value.worker, "onboarding")).toThrow(
        "Every configured routing candidate failed this task",
      )
      if (!value.mission.supervision) throw new Error("Expected Chief supervision")
      value.mission.supervision.rounds = 1
      value.mission.supervision.decisions.push({
        round: 1,
        at: "2026-11-08T06:25:00Z",
        action,
        reason: "Repair the actual JSON finding",
        fingerprint: "changed",
        taskId: "onboarding",
        instructions: "Implement proper JSON arrays",
        personaId: "worker",
      })
      const selected = selectWorkActor(value.mission, value.worker, "onboarding")
      expect(selected.actor.agentType).toBe("qwen")
      recordProbe(value, selected, "qwen-retry")
      expect(selectWorkActor(value.mission, value.worker, "onboarding").actor.agentType).toBe("codex")
      expect(value.mission.operations?.runs.find((entry) => entry.runId === "qwen-failed")?.outcome).toBe("rejected")
    },
  )

  it.each(["earlier-decision", "other-task", "wait", "stop", "repair-round-only"])(
    "does not reopen actual failures after %s",
    (condition) => {
      const value = closedPool()
      value.mission.operations?.runs.push(
        { ...value.rejection, runId: "qwen-failed", actorType: "qwen" },
        { ...value.rejection, runId: "codex-failed", actorType: "codex" },
      )
      if (!value.mission.supervision) throw new Error("Expected Chief supervision")
      value.mission.supervision.rounds = 1
      value.state.repairRound = 2
      if (condition !== "repair-round-only")
        value.mission.supervision.decisions.push({
          round: 1,
          at: condition === "earlier-decision" ? "2026-11-08T06:00:00Z" : "2026-11-08T06:25:00Z",
          action: condition === "stop" ? "stop" : condition === "wait" ? "wait" : "repair",
          reason: "Saved Chief decision",
          fingerprint: "same",
          taskId: condition === "other-task" ? "different" : "onboarding",
        })
      expect(() => selectWorkActor(value.mission, value.worker, "onboarding")).toThrow(
        "Every configured routing candidate failed this task",
      )
    },
  )

  it.each(["unknown-run", "running-task", "unknown-effect", "running-effect", "spent-repairs", "missing-task"])(
    "keeps dispatch protection for %s",
    (condition) => {
      const value = closedPool()
      if (condition === "unknown-run") value.rejection.executionState = "unknown"
      if (condition === "running-task") value.rejection.executionState = "running"
      if (condition === "unknown-effect") value.state.effectState = "unknown"
      if (condition === "running-effect") value.state.effectState = "running"
      if (condition === "spent-repairs") value.state.repairRound = 3
      if (condition === "missing-task") value.mission.tasks = []
      expect(() => selectWorkActor(value.mission, value.worker, "onboarding")).toThrow(
        ["unknown-run", "running-task"].includes(condition)
          ? "Actor execution outcome is uncertain"
          : "no remaining bounded probe",
      )
    },
  )

  it("never expands the pool or bypasses installed skill evidence and explicit models", () => {
    const value = closedPool()
    const qwenOnly = new Set([routeKey({ actorType: "qwen" })])
    expect(selectWorkActor(value.mission, value.worker, "onboarding", qwenOnly).actor.agentType).toBe("qwen")
    expect(() => selectWorkActor(value.mission, value.worker, "onboarding", new Set())).toThrow(
      "no ready work candidate",
    )
    if (value.mission.operatingPolicy) value.mission.operatingPolicy.readyActors = ["opencode"]
    expect(() => selectWorkActor(value.mission, value.worker, "onboarding")).toThrow(
      "Every configured routing candidate failed this task",
    )
    delete value.mission.availableAgents
    value.worker.model = "explicit-model"
    expect(selectWorkActor(value.mission, value.worker, "onboarding").actor).toBe(value.worker)
  })
})

/** The accepted probe is spent for this checkpoint and the later escalation failed on the other route. */
function spentPool() {
  const value = closedPool()
  if (value.mission.operatingPolicy) value.mission.operatingPolicy.readyActors = ["codex", "qwen"]
  recordProbe(value, selectWorkActor(value.mission, value.worker, "onboarding"), "accepted-probe", "passed")
  value.mission.operations?.runs.push({ ...value.rejection, runId: "later-failure", actorType: "codex" })
  return value
}

describe("degraded routing below the measured minimum", () => {
  it("keeps working on the best measured ready route instead of failing the whole mission", () => {
    const { mission, worker } = spentPool()
    const before = structuredClone(mission)
    const selected = selectWorkActor(mission, worker, "onboarding")
    expect(selected.actor).toMatchObject({ id: "worker", agentType: "qwen" })
    expect(selected.reason).toBe("Degraded: every route is below min_success_rate; selected the best measured route.")
    expect(mission).toEqual(before)
  })

  it("still fails honestly once every ready route failed this task", () => {
    const { mission, worker, rejection } = spentPool()
    mission.operations?.runs.push({ ...rejection, runId: "qwen-failed", actorType: "qwen" })
    expect(() => selectWorkActor(mission, worker, "onboarding")).toThrow(
      "Every configured routing candidate failed this task",
    )
  })
})

describe("degraded route ordering", () => {
  const candidates: RoutingCandidate[] = [
    { actorType: "codex", inputPerMillionUsd: 3, outputPerMillionUsd: 3 },
    { actorType: "qwen", inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
    { actorType: "opencode", inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
  ]

  /** A poor lifetime aggregate with a full recent window: only the window may decide the order. */
  function record(actorType: string, passed: number): RouteEvidence {
    return {
      actorType,
      samples: 30,
      successes: 0,
      totalCostUsd: null,
      successfulDeliverableCostUsd: null,
      recent: Array.from(
        { length: 10 },
        (_, index): RouteOutcome => ({
          at: new Date(Date.UTC(2026, 10, 8, 0, index)).toISOString(),
          outcome: index < passed ? "passed" : "failed",
        }),
      ),
    }
  }

  function select(evidence: RouteEvidence[], pool: RoutingCandidate[] = candidates) {
    const { mission } = closedPool()
    return degradedWorkRoute(mission, "onboarding", pool, evidence, mission.operations?.runs ?? [], 10, routeKey)
  }

  it("prefers the highest windowed success rate over the configured price", () => {
    expect(select([record("codex", 6), record("qwen", 4)])?.candidate.actorType).toBe("codex")
  })

  it("breaks a rate tie by configured price and then by candidate order", () => {
    expect(select([record("codex", 5), record("qwen", 5)])?.candidate.actorType).toBe("qwen")
    expect(select([record("qwen", 5), record("opencode", 5)])?.candidate.actorType).toBe("qwen")
  })

  it("keeps the saved checkpoint protection and returns nothing for an empty pool", () => {
    const { mission } = closedPool()
    const state = mission.tasks[0]
    if (!state) throw new Error("Expected the saved task")
    state.effectState = "unknown"
    expect(
      degradedWorkRoute(
        mission,
        "onboarding",
        candidates,
        [record("qwen", 9)],
        mission.operations?.runs ?? [],
        10,
        routeKey,
      ),
    ).toBeUndefined()
    expect(select([record("codex", 5)], [])).toBeUndefined()
  })
})
