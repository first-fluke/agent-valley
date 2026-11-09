import { describe, expect, it } from "vitest"
import { ACTOR_COOLDOWN_MAX_MS, ACTOR_PROBE_GRACE_MS, actorRouteHealth, aggregateProviderHealth } from "./actor-health"
import { fixture } from "./goal-supervision.fixture"
import { type OperatingRun, operatingRunSchema, providerHealthSchema, routeEvidenceSchema } from "./operations"
import { routingCancellationFixture } from "./routing-cancellation.fixture"

const start = Date.parse("2026-11-10T00:00:00.000Z")
const at = (offset = 0) => new Date(start + offset).toISOString()
const route = { actorType: "qwen" }

function run(id: string, offset = 0, changes: Partial<OperatingRun> = {}): OperatingRun {
  return {
    runId: id,
    taskId: "onboarding",
    stage: "work",
    actorId: "worker",
    actorType: "qwen",
    startedAt: at(offset),
    finishedAt: at(offset + 1_000),
    elapsedMs: 1_000,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    outcome: "failed",
    nativeOutcome: "failed",
    executionState: "settled",
    executionRecovery: "local-process",
    ...changes,
  }
}

function setup(runs: OperatingRun[] = []) {
  const { mission } = fixture()
  const operations: NonNullable<typeof mission.operations> = { runs, routingEvidence: [], reviewDecisions: [] }
  return Object.assign(mission, { operations })
}

describe("Actor route cooldown", () => {
  it("backs off repeated execution failures for 15m, 30m, 1h, 2h, 4h, then at most 6h", () => {
    const mission = setup()
    const originalExecution = { startedAt: at(), runsStarted: 17, retries: 2 }
    mission.execution = originalExecution
    const minutes = [15, 30, 60, 120, 240, 360, 360]
    for (const [index, duration] of minutes.entries()) {
      const offset = index * 1_000
      mission.operations.runs.push(run(`failed-${index}`, offset, { evidence: "Agent exited with code 1: ECONNRESET" }))
      const health = actorRouteHealth(mission, route, start + offset + 1_000)
      expect(health).toMatchObject({
        state: "cooling",
        consecutiveFailures: index + 1,
        retryAt: at(offset + 1_000 + duration * 60_000),
      })
    }
    expect(mission.execution).toEqual(originalExecution)
    expect(mission.operations.runs).toHaveLength(7)
    expect(ACTOR_COOLDOWN_MAX_MS).toBe(6 * 60 * 60_000)
  })

  it("does not cool a route when a framework attempt deadline settles as a native failure", () => {
    const mission = setup([run("timeout", 0, { evidence: "Agent timed out after 1800s" })])
    expect(actorRouteHealth(mission, route, start + 2_000)).toMatchObject({
      state: "ready",
      consecutiveFailures: 0,
    })
  })

  it("still cools a route after a genuine provider transport failure", () => {
    const mission = setup([run("crash", 0, { evidence: "Agent exited with code 1: ECONNRESET" })])
    expect(actorRouteHealth(mission, route, start + 2_000)).toMatchObject({
      state: "cooling",
      consecutiveFailures: 1,
      retryAt: at(1_000 + 15 * 60_000),
    })
  })

  it("does not reset or extend a prior failure streak when a later attempt hits the framework deadline", () => {
    const mission = setup([
      run("crash", 0, { evidence: "Agent exited with code 1: ECONNRESET" }),
      run("timeout", 2_000, { evidence: "Agent timed out after 1800s" }),
    ])
    expect(actorRouteHealth(mission, route, start + 4_000)).toMatchObject({
      state: "cooling",
      consecutiveFailures: 1,
      retryAt: at(1_000 + 15 * 60_000),
    })
  })

  it("retains cooldown through new tasks, replans, retries and changed reported native defaults", () => {
    const mission = setup([
      run("first", 0, { actualModel: "qwen-a", taskId: "old-task" }),
      run("second", 1_000, { actualModel: "qwen-b", taskId: "replacement-task" }),
    ])
    mission.tasks = []
    mission.plan = { tasks: [] }
    mission.execution = { startedAt: at(), runsStarted: 2, retries: 8, interventionAt: at(3_000) }
    const before = structuredClone(mission)
    expect(actorRouteHealth(mission, route, start + 3_000)).toMatchObject({ state: "cooling", consecutiveFailures: 2 })
    expect(actorRouteHealth(mission, { actorType: "qwen", model: "qwen-b" }, start + 3_000).state).toBe("ready")
    expect(actorRouteHealth(mission, { actorType: "opencode" }, start + 3_000).state).toBe("ready")
    expect(mission).toEqual(before)
  })

  it("keeps explicitly requested models separate without using the reported model as a new key", () => {
    const mission = setup([run("model-a", 0, { model: "fixed-a", actualModel: "reported-b" })])
    expect(actorRouteHealth(mission, { actorType: "qwen", model: "fixed-a" }, start + 2_000).state).toBe("cooling")
    expect(actorRouteHealth(mission, { actorType: "qwen", model: "reported-b" }, start + 2_000).state).toBe("ready")
    expect(actorRouteHealth(mission, route, start + 2_000).state).toBe("ready")
  })

  it.each(["pending", "passed", "rejected", "failed"] as const)(
    "resets after proven native success even when the later AV verdict is %s",
    (outcome) => {
      const mission = setup([
        run("failed"),
        run("native-success", 2_000, { nativeOutcome: "passed", outcome, evidence: "Acceptance or receipt failed" }),
      ])
      expect(actorRouteHealth(mission, route, start + 4_000)).toMatchObject({ state: "ready", consecutiveFailures: 0 })
      mission.operations.runs.push(run("failed-again", 4_000))
      expect(actorRouteHealth(mission, route, start + 6_000)).toMatchObject({
        consecutiveFailures: 1,
        retryAt: at(5_000 + 15 * 60_000),
      })
    },
  )

  it.each(["pending", "passed", "rejected"] as const)(
    "recognizes legacy terminal native success without turning %s into a provider failure",
    (outcome) => {
      const mission = setup([run("failed"), run("legacy-success", 2_000, { nativeOutcome: undefined, outcome })])
      expect(actorRouteHealth(mission, route, start + 4_000)).toMatchObject({ state: "ready", consecutiveFailures: 0 })
    },
  )

  it("includes work and independent review transport failures while leaving Chief stages out", () => {
    const mission = setup([
      run("work", 0),
      run("review", 1_000, { stage: "review" }),
      run("gate", 2_000, { stage: "gate-review" }),
      run("final", 3_000, { stage: "final-review" }),
      run("chief-plan", 4_000, { stage: "plan" }),
      run("chief-supervise", 5_000, { stage: "supervise" }),
      run("chief-report", 6_000, { stage: "report" }),
    ])
    expect(actorRouteHealth(mission, route, start + 8_000)).toMatchObject({
      consecutiveFailures: 4,
      retryAt: at(4_000 + 120 * 60_000),
    })
  })

  it("folds historical settled failures without claiming a specific provider diagnosis", () => {
    const mission = setup([run("legacy", 0, { nativeOutcome: undefined, evidence: undefined })])
    expect(actorRouteHealth(mission, route, start + 2_000)).toMatchObject({ state: "cooling", consecutiveFailures: 1 })
    expect(actorRouteHealth(mission, route, start + 2_000).reason).not.toContain("provider outage")
    mission.operations.runs.push(
      run("receipt", 2_000, { nativeOutcome: undefined, evidence: "OMA completion evidence failed: missing receipt" }),
      run("path", 3_000, { nativeOutcome: undefined, evidence: "ENOENT: verification command missing from PATH" }),
      run("abandoned", 4_000, {
        nativeOutcome: undefined,
        evidence: "Coordinator process ended before usage could be reconciled; cost remains unknown.",
      }),
    )
    expect(actorRouteHealth(mission, route, start + 6_000).consecutiveFailures).toBe(1)
  })

  it("allows one expired-cooldown probe and blocks overlapping probes until a terminal result", () => {
    const mission = setup([run("failed")])
    const expired = start + 1_000 + 15 * 60_000
    expect(actorRouteHealth(mission, route, expired)).toMatchObject({ state: "ready", consecutiveFailures: 1 })
    mission.operations.runs.push(
      run("probe", expired - start, {
        finishedAt: null,
        outcome: "pending",
        nativeOutcome: undefined,
        executionState: "running",
      }),
    )
    expect(actorRouteHealth(mission, route, expired)).toMatchObject({
      state: "probe-in-flight",
      retryAt: new Date(expired + mission.timeoutSec * 1000 + ACTOR_PROBE_GRACE_MS).toISOString(),
    })
    expect(actorRouteHealth(mission, route, expired + 1_000_000)).toMatchObject({
      state: "probe-in-flight",
      retryAt: new Date(expired + 1_000_000 + ACTOR_PROBE_GRACE_MS).toISOString(),
    })
    mission.operations.runs[1] = run("probe", expired - start)
    expect(actorRouteHealth(mission, route, expired + 2_000)).toMatchObject({
      state: "cooling",
      consecutiveFailures: 2,
    })
  })

  it("allows healthy parallel native work instead of imposing a new global serialization rule", () => {
    const mission = setup([
      run("healthy-work", 0, {
        finishedAt: null,
        nativeOutcome: undefined,
        outcome: "pending",
        executionState: "running",
      }),
    ])
    expect(actorRouteHealth(mission, route, start + 2_000)).toMatchObject({ state: "ready", consecutiveFailures: 0 })
  })

  it.each(["work", "review", "gate-review", "final-review"] as const)(
    "does not count a framework-attested %s cancellation or reset its earlier failure",
    (stage) => {
      const mission = setup([run("failed"), run("cancelled", 2_000, { stage, nativeOutcome: "cancelled" })])
      const before = structuredClone(mission.operations)
      expect(actorRouteHealth(mission, route, start + 4_000).consecutiveFailures).toBe(1)
      expect(mission.operations).toEqual(before)
    },
  )

  it("retains the established legacy operator-cancellation proof without adding a failure", () => {
    const { mission } = routingCancellationFixture()
    expect(actorRouteHealth(mission, { actorType: "opencode" }, start)).toMatchObject({
      state: "ready",
      consecutiveFailures: 0,
    })
    expect(aggregateProviderHealth(mission)).toEqual([])
  })

  it("blocks unknown or malformed terminal evidence without counting it as another failure", () => {
    for (const changes of [
      { executionState: "unknown" as const, finishedAt: null },
      { finishedAt: "bad-date" },
      { finishedAt: at(-1_000) },
      { executionState: undefined, finishedAt: null },
    ]) {
      const mission = setup([run("failed"), run("uncertain", 2_000, changes)])
      expect(actorRouteHealth(mission, route, start + 4_000)).toMatchObject({
        state: "unknown",
        consecutiveFailures: 1,
      })
    }
  })

  it("carries native health into the next child and deduplicates seed-covered local observations", () => {
    const first = setup([run("first"), run("second", 2_000)])
    const [seed] = aggregateProviderHealth(first)
    if (!seed) throw new Error("Expected saved Actor health")
    const next = setup([run("second", 2_000), run("third", 4_000)])
    next.operations.routingEvidence = [
      { ...seed, samples: 0, successes: 0, totalCostUsd: 0, successfulDeliverableCostUsd: null },
    ]
    const before = structuredClone(next)
    expect(actorRouteHealth(next, route, start + 6_000)).toMatchObject({
      consecutiveFailures: 3,
      retryAt: at(5_000 + 60 * 60_000),
    })
    expect(next).toEqual(before)
  })

  it("orders terminal observations and counts distinct failures finishing in the same millisecond", () => {
    const mission = setup([run("latest", 4_000), run("first"), run("same-time", 4_000), run("middle", 2_000)])
    expect(actorRouteHealth(mission, route, start + 6_000)).toMatchObject({
      consecutiveFailures: 4,
      retryAt: at(5_000 + 120 * 60_000),
    })
  })

  it("validates optional persisted health and native results while retaining legacy records", () => {
    expect(operatingRunSchema.safeParse(run("legacy", 0, { nativeOutcome: undefined })).success).toBe(true)
    expect(operatingRunSchema.safeParse(run("cancelled", 0, { nativeOutcome: "cancelled" })).success).toBe(true)
    expect(operatingRunSchema.safeParse({ ...run("bad"), nativeOutcome: "unknown" }).success).toBe(false)
    const [seed] = aggregateProviderHealth(setup([run("seed")]))
    expect(
      routeEvidenceSchema.safeParse({
        ...seed,
        samples: 0,
        successes: 0,
        totalCostUsd: 0,
        successfulDeliverableCostUsd: null,
      }).success,
    ).toBe(true)
    expect(providerHealthSchema.safeParse({ consecutiveFailures: -1, lastOutcomeAt: at() }).success).toBe(false)
    expect(providerHealthSchema.safeParse({ consecutiveFailures: 1, lastOutcomeAt: "yesterday" }).success).toBe(false)
  })
})
