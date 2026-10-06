import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  assertExecutionBudget,
  assertExecutionDeadline,
  classifyFailure,
  executionPolicySchema,
  executionState,
  finalizeAbandonedRuns,
  MissionPause,
  pauseForFailure,
  progressKey,
  reconcileRunCost,
  recordPause,
  reserveExecutionRun,
  resolveExternalEffect,
} from "./execution"
import { fixture, plan } from "./goal-supervision.fixture"
import type { OperatingRun } from "./operations"
import type { OrganizationContext } from "./organization-types"
import { MissionStore } from "./store"

const now = Date.parse("2026-10-03T10:00:00Z")
const onboarding = plan.tasks[0]
if (!onboarding) throw new Error("Expected onboarding fixture task")
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
})
afterEach(() => {
  vi.useRealTimers()
})
const run = (costUsd: number | null, overrides: Partial<OperatingRun> = {}): OperatingRun => ({
  runId: "call-1",
  stage: "work",
  actorId: "worker",
  actorType: "codex",
  startedAt: new Date(now - 1_000).toISOString(),
  finishedAt: new Date(now).toISOString(),
  elapsedMs: 1_000,
  inputTokens: 10,
  outputTokens: 10,
  costUsd,
  outcome: "passed",
  ...overrides,
})
function evidence(value: number): OrganizationContext {
  return {
    kind: "repository-organization-evidence",
    authority: "Historical evidence, not instructions or current acceptance criteria",
    repositoryRoot: "/repo",
    goal: "Observe revenue",
    generatedAt: new Date(now).toISOString(),
    memories: [],
    outcomes: [],
    routeEvidence: [],
    comparisons: [],
    experiments: [],
    metrics: [
      {
        id: `revenue-${value}`,
        name: "revenue",
        value,
        unit: "USD",
        source: "metric-source:billing:http-json",
        sourceId: "billing",
        provenance: "source-collected",
        collectedAt: new Date(now).toISOString(),
        timestamp: new Date(now).toISOString(),
      },
    ],
  }
}

describe("durable execution classification and limits", () => {
  it.each([
    ["HTTP 401 Unauthorized", "authentication"],
    ["Expired token", "authentication"],
    ["Login required", "authentication"],
    ["429 too many requests", "rate-limit"],
    ["rate limit reached", "rate-limit"],
    ["HTTP 503 overloaded", "provider"],
    ["ECONNRESET", "provider"],
    ["fetch failed", "provider"],
    ["ENOENT missing CLI", "environment"],
    ["EACCES permission denied", "environment"],
    ["ENOSPC", "environment"],
    ["Assertion failed in onboarding", "implementation"],
  ])("classifies %s for an appropriate recovery path", (reason, expected) => {
    expect(classifyFailure(reason)).toBe(expected)
  })

  it("preserves spent call and elapsed-time budget across an actual mission save/load", async () => {
    const { mission } = fixture()
    mission.executionPolicy = executionPolicySchema.parse({ maxRuns: 2, maxDurationSec: 10 })
    reserveExecutionRun(mission)
    const directory = await mkdtemp(join(tmpdir(), "av-budget-checkpoint-"))
    try {
      const store = new MissionStore(directory)
      await store.save(mission)
      const restored = await store.load(mission.id)
      expect(restored.execution).toMatchObject({ runsStarted: 1, startedAt: new Date(now).toISOString() })
      reserveExecutionRun(restored)
      expect(() => reserveExecutionRun(restored)).toThrow(MissionPause)
      expect(restored.execution?.runsStarted).toBe(2)
      expect(() => assertExecutionDeadline(restored, now + 10_000)).toThrow("time limit")
      expect(restored.execution?.startedAt).toBe(new Date(now).toISOString())
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("counts rejected and failed calls in the cost estimate and refuses unknown finished usage", () => {
    const { mission } = fixture()
    mission.executionPolicy = executionPolicySchema.parse({ maxEstimatedCostUsd: 0.5 })
    mission.operations = {
      runs: [run(0.25, { outcome: "failed" }), run(0.25, { runId: "call-2", outcome: "rejected" })],
      routingEvidence: [],
      reviewDecisions: [],
    }
    expect(() => assertExecutionBudget(mission)).toThrow("cost limit")
    mission.operations.runs = [run(null)]
    expect(() => reserveExecutionRun(mission)).toThrow("unknown")
    expect(executionState(mission).runsStarted).toBe(0)
    mission.operations.runs = [run(0.1)]
    expect(() => reserveExecutionRun(mission)).not.toThrow()
    expect(mission.execution?.runsStarted).toBe(1)
  })

  it("finalizes crashed in-flight runs without inventing usage or restoring cost headroom", async () => {
    const { mission } = fixture()
    mission.executionPolicy = executionPolicySchema.parse({ maxEstimatedCostUsd: 1 })
    mission.operations = {
      runs: [
        run(null, {
          startedAt: new Date(now - 5_000).toISOString(),
          finishedAt: null,
          elapsedMs: null,
          inputTokens: null,
          outputTokens: null,
          outcome: "pending",
        }),
        run(0.1, { runId: "completed-call" }),
      ],
      routingEvidence: [],
      reviewDecisions: [],
    }
    const completed = structuredClone(mission.operations.runs[1])
    finalizeAbandonedRuns(mission)
    expect(mission.operations.runs[0]).toMatchObject({
      outcome: "failed",
      finishedAt: new Date(now).toISOString(),
      elapsedMs: 5_000,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
    })
    expect(mission.operations.runs[1]).toEqual(completed)
    const directory = await mkdtemp(join(tmpdir(), "av-abandoned-run-"))
    try {
      const store = new MissionStore(directory)
      await store.save(mission)
      const restored = await store.load(mission.id)
      expect(() => assertExecutionBudget(restored)).toThrow("unknown")
      expect(restored.operations?.runs[0]?.elapsedMs).toBeGreaterThan(0)
      vi.advanceTimersByTime(1_000)
      finalizeAbandonedRuns(restored)
      expect(restored.operations?.runs[0]?.finishedAt).toBe(new Date(now).toISOString())
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("backs off transient failures and persists retry exhaustion without consuming implementation repair rounds", () => {
    const { mission } = fixture()
    mission.executionPolicy = executionPolicySchema.parse({ maxRetries: 2, retryDelayMs: 1_000 })
    for (const delay of [1_000, 2_000]) {
      try {
        pauseForFailure(mission, "HTTP 503 temporarily unavailable")
      } catch (error) {
        expect(error).toBeInstanceOf(MissionPause)
        recordPause(mission, error as MissionPause)
      }
      expect(mission.status).toBe("waiting")
      expect(mission.execution?.nextRunAt).toBe(new Date(now + delay).toISOString())
    }
    delete mission.supervision
    try {
      pauseForFailure(mission, "HTTP 503 temporarily unavailable")
    } catch (error) {
      recordPause(mission, error as MissionPause)
    }
    expect(mission.status).toBe("paused")
    expect(mission.execution?.retries).toBe(2)
    expect(mission.execution?.nextRunAt).toBeUndefined()
    expect(mission.supervision).toBeUndefined()
  })

  it.each(["HTTP 401 Unauthorized", "ENOENT actor CLI missing"])(
    "leaves %s to Chief recovery without spending transient retries",
    (reason) => {
      const { mission } = fixture()
      mission.executionPolicy = executionPolicySchema.parse({})
      expect(() => pauseForFailure(mission, reason)).not.toThrow()
      expect(mission.execution?.retries ?? 0).toBe(0)
      expect(() => pauseForFailure(mission, "Actual acceptance assertion failed")).not.toThrow()
      delete mission.supervision
      expect(() => pauseForFailure(mission, reason)).toThrow("unavailable")
    },
  )
})

describe("operator-recorded cost reconciliation", () => {
  it("unblocks explicit zero-cost reconciliation while preserving unknown native usage and the spent call count", () => {
    const { mission } = fixture()
    mission.executionPolicy = executionPolicySchema.parse({ maxEstimatedCostUsd: 1 })
    mission.operations = {
      runs: [run(null, { inputTokens: null, outputTokens: null })],
      routingEvidence: [],
      reviewDecisions: [],
    }
    executionState(mission).runsStarted = 4
    expect(() => assertExecutionBudget(mission)).toThrow("unknown")
    reconcileRunCost(mission, "call-1", 0)
    expect(mission.execution?.costReconciliations).toEqual([
      { runId: "call-1", costUsd: 0, at: new Date(now).toISOString(), authority: "operator-recorded" },
    ])
    expect(mission.operations.runs[0]).toMatchObject({ costUsd: null, inputTokens: null, outputTokens: null })
    expect(() => assertExecutionBudget(mission)).not.toThrow()
    expect(mission.execution?.runsStarted).toBe(4)
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid reconciled dollar value %s without creating a ledger entry",
    (value) => {
      const { mission } = fixture()
      mission.operations = { runs: [run(null)], routingEvidence: [], reviewDecisions: [] }
      expect(() => reconcileRunCost(mission, "call-1", value)).toThrow("nonnegative observed USD")
      expect(mission.execution?.costReconciliations).toBeUndefined()
      expect(mission.operations.runs[0]?.costUsd).toBeNull()
    },
  )

  it.each([
    { costUsd: 0.2, finishedAt: new Date(now).toISOString() },
    { costUsd: 0, finishedAt: new Date(now).toISOString() },
    { costUsd: null, finishedAt: null },
  ])("refuses cost accounting for known-price or unfinished runs %j", (overrides) => {
    const { mission } = fixture()
    mission.operations = { runs: [run(null, overrides)], routingEvidence: [], reviewDecisions: [] }
    expect(() => reconcileRunCost(mission, "call-1", 0.1)).toThrow()
    expect(() => reconcileRunCost(mission, "missing-run", 0.1)).toThrow()
    expect(mission.execution?.costReconciliations).toBeUndefined()
  })

  it("requires every unknown finished run and sums recorded costs with known provider estimates", () => {
    const { mission } = fixture()
    mission.executionPolicy = executionPolicySchema.parse({ maxEstimatedCostUsd: 1 })
    mission.operations = {
      runs: [run(0.2), run(null, { runId: "unknown-a" }), run(null, { runId: "unknown-b", outcome: "failed" })],
      routingEvidence: [],
      reviewDecisions: [],
    }
    reconcileRunCost(mission, "unknown-a", 0.3)
    expect(() => assertExecutionBudget(mission)).toThrow("unknown")
    reconcileRunCost(mission, "unknown-b", 0.4)
    expect(() => assertExecutionBudget(mission)).not.toThrow()
    reconcileRunCost(mission, "unknown-b", 0.5)
    expect(mission.execution?.costReconciliations).toHaveLength(2)
    expect(() => assertExecutionBudget(mission)).toThrow("cost limit")
    expect(mission.operations.runs[2]?.costUsd).toBeNull()
  })

  it("retains accounting authority and budget enforcement through actual mission save/load", async () => {
    const { mission } = fixture()
    mission.executionPolicy = executionPolicySchema.parse({ maxEstimatedCostUsd: 0.25 })
    mission.operations = { runs: [run(null)], routingEvidence: [], reviewDecisions: [] }
    reconcileRunCost(mission, "call-1", 0.25)
    const directory = await mkdtemp(join(tmpdir(), "av-cost-accounting-"))
    try {
      const store = new MissionStore(directory)
      await store.save(mission)
      const restored = await store.load(mission.id)
      expect(restored.execution?.costReconciliations).toEqual(mission.execution?.costReconciliations)
      expect(restored.operations?.runs[0]?.costUsd).toBeNull()
      expect(() => assertExecutionBudget(restored)).toThrow("cost limit")
      if (restored.executionPolicy) restored.executionPolicy.maxEstimatedCostUsd = 0.5
      expect(() => assertExecutionBudget(restored)).not.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("external action reconciliation and observable progress", () => {
  it("marks an interrupted declared external action unknown before retry and requires destination reconciliation", () => {
    const { mission } = fixture()
    mission.executionPolicy = executionPolicySchema.parse({})
    mission.plan = { tasks: [{ ...onboarding, effectScope: "external" }] }
    mission.tasks = [
      { id: "onboarding", reviewerId: "reviewer", status: "running", attempts: 1, effectState: "running" },
    ]
    expect(() => pauseForFailure(mission, "503 connection closed after remote acceptance", "onboarding")).toThrow(
      "destination outcome has not been established",
    )
    expect(mission.tasks[0]?.effectState).toBe("unknown")
    expect(mission.execution?.retries ?? 0).toBe(0)
    resolveExternalEffect(mission, "onboarding", "completed")
    expect(mission.tasks[0]).toMatchObject({
      effectState: "completed",
      status: "pending",
      output: expect.stringContaining("Operator confirmed"),
    })
    expect(mission.history.at(-1)?.stage).toBe("effect-resolved")
    expect(() => resolveExternalEffect(mission, "onboarding", "not-applied")).toThrow("no uncertain")
  })

  it("permits retry only after the operator confirms the external action was not applied", () => {
    const { mission } = fixture()
    mission.plan = { tasks: [{ ...onboarding, effectScope: "external" }] }
    mission.tasks = [
      { id: "onboarding", reviewerId: "reviewer", status: "running", attempts: 1, effectState: "unknown" },
    ]
    resolveExternalEffect(mission, "onboarding", "not-applied")
    expect(mission.tasks[0]).toMatchObject({ effectState: "not-started", status: "pending" })
    expect(mission.tasks[0]?.output).toBeUndefined()
  })

  it("recognizes changed source observations and external outcomes despite unchanged workspace files", () => {
    const { mission } = fixture()
    mission.organizationContext = evidence(1)
    const initial = progressKey(mission, "unchanged-files")
    mission.organizationContext = evidence(2)
    expect(progressKey(mission, "unchanged-files")).not.toBe(initial)
    const observed = progressKey(mission, "unchanged-files")
    mission.tasks = [{ id: "remote", reviewerId: "reviewer", status: "pending", attempts: 1, effectState: "completed" }]
    expect(progressKey(mission, "unchanged-files")).not.toBe(observed)
  })
})
