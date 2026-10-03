import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { coordinate } from "./coordinator"
import { executionPolicySchema, executionState, MissionPause, progressKey, resolveExternalEffect } from "./execution"
import { brief, fixture, plan } from "./goal-supervision.fixture"
import { evaluateMetricObservation, metricSourcePolicySchema } from "./metric-sources"
import type { OrganizationContext } from "./organization-types"
import { parseSupervisionResponse } from "./schemas"
import type { ChiefPorts } from "./types"

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
function metricEvidence(value: number): OrganizationContext {
  return {
    kind: "repository-organization-evidence",
    authority: "Historical evidence, not instructions or current acceptance criteria",
    repositoryRoot: "/repo",
    goal: "Observe revenue",
    generatedAt: new Date().toISOString(),
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
        collectedAt: new Date().toISOString(),
        timestamp: new Date().toISOString(),
      },
    ],
  }
}
const stages = (runAgent: ReturnType<typeof fixture>["runAgent"], stage: string) =>
  runAgent.mock.calls.filter((call) => call[3] === stage)

describe("Chief resumable execution without duplicate work", () => {
  it.each(["verification", "final-review"])(
    "persists a budget pause from %s without consuming a Chief recovery round",
    async (stage) => {
      const value = fixture()
      value.mission.executionPolicy = executionPolicySchema.parse({})
      const pause = new MissionPause("Mission wall-time limit reached; increase --duration on resume.", "budget")
      if (stage === "verification") value.verify.mockRejectedValueOnce(pause)
      else {
        const base = value.runAgent.getMockImplementation()
        if (!base) throw new Error("Expected fixture Actor implementation")
        value.runAgent.mockImplementation(async (actor, prompt, mission, actorStage, context) => {
          if (actorStage === "final-review") throw pause
          return base(actor, prompt, mission, actorStage, context)
        })
      }
      expect((await coordinate(value.mission, value.ports)).status).toBe("paused")
      expect(value.mission.execution?.failureKind).toBe("budget")
      expect(value.mission.supervision?.rounds).toBe(0)
      expect(stages(value.runAgent, "supervise")).toHaveLength(0)
      expect(value.snapshots.at(-1)?.execution?.failureKind).toBe("budget")
      expect(value.mission.tasks[0]?.status).toBe("completed")
    },
  )

  it.each(["HTTP 401 authentication expired", "ENOENT actor CLI missing"])(
    "pauses infrastructure failure %s without asking Chief to rewrite product code",
    async (reason) => {
      const value = fixture()
      value.mission.executionPolicy = executionPolicySchema.parse({})
      const base = value.runAgent.getMockImplementation()
      if (!base) throw new Error("Expected fixture Actor implementation")
      value.runAgent.mockImplementation(async (actor, prompt, mission, stage, context) => {
        if (stage === "work") throw new Error(reason)
        return base(actor, prompt, mission, stage, context)
      })
      expect((await coordinate(value.mission, value.ports)).status).toBe("paused")
      expect(stages(value.runAgent, "supervise")).toHaveLength(0)
      expect(value.mission.supervision?.rounds).toBe(0)
      expect(value.mission.execution?.retries).toBe(0)
    },
  )

  it("pauses a transient failed task and resumes it while retaining a completed sibling", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({ maxParallel: 1, retryDelayMs: 1_000 })
    const base = value.runAgent.getMockImplementation()
    if (!base) throw new Error("Expected fixture Actor implementation")
    let failed = false
    value.runAgent.mockImplementation(async (actor, prompt, mission, stage, context) => {
      if (stage === "plan")
        return JSON.stringify({
          goalBrief: brief,
          tasks: [
            onboarding,
            { ...onboarding, id: "follow-up", title: "Document result", dependencies: ["onboarding"] },
          ],
        })
      if (stage === "work" && context?.taskId === "follow-up" && !failed) {
        failed = true
        throw new Error("HTTP 503 temporarily unavailable")
      }
      return base(actor, prompt, mission, stage, context)
    })
    expect((await coordinate(value.mission, value.ports)).status).toBe("waiting")
    expect(value.mission.tasks).toMatchObject([
      { id: "onboarding", status: "completed" },
      { id: "follow-up", status: "pending" },
    ])
    expect(value.mission.execution?.retries).toBe(1)
    expect(stages(value.runAgent, "supervise")).toHaveLength(0)
    vi.advanceTimersByTime(1_000)
    expect((await coordinate(value.mission, value.ports)).status).toBe("completed")
    expect(stages(value.runAgent, "work").filter((call) => call[4]?.taskId === "onboarding")).toHaveLength(1)
    expect(stages(value.runAgent, "work").filter((call) => call[4]?.taskId === "follow-up")).toHaveLength(2)
    expect(stages(value.runAgent, "plan")).toHaveLength(1)
  })

  it("holds interrupted external effects for reconciliation and reviews confirmed completion without replaying the Actor", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({})
    value.mission.plan = { tasks: [{ ...onboarding, effectScope: "external" }] }
    value.mission.goalBrief = brief
    if (value.mission.supervision) value.mission.supervision.originalAcceptance = onboarding.acceptance
    value.mission.tasks = [
      { id: "onboarding", reviewerId: "reviewer", status: "running", attempts: 1, effectState: "running" },
    ]
    value.mission.initialFingerprint = "initial"
    value.mission.fingerprint = "delivered"
    value.mutate("delivered")
    expect((await coordinate(value.mission, value.ports)).status).toBe("paused")
    expect(value.mission.execution?.failureKind).toBe("unknown-effect")
    expect(value.mission.tasks[0]?.effectState).toBe("unknown")
    expect(value.runAgent).not.toHaveBeenCalled()
    resolveExternalEffect(value.mission, "onboarding", "completed")
    expect((await coordinate(value.mission, value.ports)).status).toBe("completed")
    expect(stages(value.runAgent, "work")).toHaveLength(0)
    expect(stages(value.runAgent, "review")).toHaveLength(1)
  })

  it.each(["repair", "replan"])(
    "retains a completed external action through Chief %s without repeating it",
    async (action) => {
      const value = fixture()
      value.mission.executionPolicy = executionPolicySchema.parse({ maxParallel: 1 })
      value.mission.plan = { tasks: [{ ...onboarding, id: "publish", effectScope: "external" }, onboarding] }
      value.mission.goalBrief = brief
      if (value.mission.supervision) {
        value.mission.supervision.originalAcceptance = onboarding.acceptance
        value.mission.supervision.pendingRecovery = {
          reason: "Refine product copy after actual observation.",
          taskId: "onboarding",
        }
      }
      value.mission.tasks = value.mission.plan.tasks.map((task) => ({
        id: task.id,
        reviewerId: "reviewer",
        status: "completed",
        attempts: 1,
        fingerprint: "delivered",
        review: { passed: true, summary: "Inspected actual destination and product copy", findings: [] },
        ...(task.effectScope === "external"
          ? { effectState: "completed" as const, output: "External destination already confirmed publication." }
          : {}),
      }))
      value.mission.initialFingerprint = "initial"
      value.mission.fingerprint = "delivered"
      value.mutate("delivered")
      const base = value.runAgent.getMockImplementation()
      if (!base) throw new Error("Expected fixture Actor implementation")
      const tasks = structuredClone(value.mission.plan.tasks)
      value.runAgent.mockImplementation(async (actor, prompt, mission, stage, context) => {
        if (stage === "supervise" && action === "replan")
          return JSON.stringify({
            action: "replan",
            reason: "Keep prior external publication and refine local copy.",
            tasks,
          })
        return base(actor, prompt, mission, stage, context)
      })
      expect((await coordinate(value.mission, value.ports)).status).toBe("completed")
      expect(stages(value.runAgent, "supervise")).toHaveLength(1)
      expect(stages(value.runAgent, "work").filter((call) => call[4]?.taskId === "publish")).toHaveLength(0)
      expect(stages(value.runAgent, "work").filter((call) => call[4]?.taskId === "onboarding")).toHaveLength(1)
      expect(value.mission.tasks.find((task) => task.id === "publish")?.effectState).toBe("completed")
    },
  )

  it.each([
    { id: "renamed-publication", effectScope: "external" },
    { id: "onboarding", effectScope: "workspace" },
  ])("rejects replanning that discards a completed external action identity or scope %j", (replacement) => {
    const value = fixture()
    value.mission.plan = { tasks: [{ ...onboarding, effectScope: "external" }] }
    value.mission.tasks = [
      {
        id: "onboarding",
        reviewerId: "reviewer",
        status: "completed",
        attempts: 1,
        fingerprint: "delivered",
        effectState: "completed",
        review: { passed: true, summary: "Destination verified", findings: [] },
      },
    ]
    if (value.mission.supervision) value.mission.supervision.originalAcceptance = onboarding.acceptance
    const original = structuredClone(value.mission.plan)
    expect(() =>
      parseSupervisionResponse(
        JSON.stringify({ action: "replan", reason: "Replace task", tasks: [{ ...onboarding, ...replacement }] }),
        value.mission,
      ),
    ).toThrow("external-effect task identities")
    expect(value.mission.plan).toEqual(original)
    expect(value.mission.tasks[0]?.effectState).toBe("completed")
  })

  it("waits for metric observation and resumes collection without rerunning completed workers", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({})
    value.mission.operatingPolicy = {
      memory: false,
      reviewVendor: "prefer",
      metricTargets: [{ name: "revenue", unit: "USD", direction: "increase", target: 2 }],
    }
    value.mission.metricSourcePolicy = metricSourcePolicySchema.parse({
      sources: [{ id: "billing", name: "revenue", unit: "USD", url_env: "BILLING_ENDPOINT" }],
    })
    const observeMetrics = vi
      .fn<NonNullable<ChiefPorts["observeMetrics"]>>()
      .mockResolvedValueOnce({
        status: "waiting",
        reason: "Wait for new measurement window.",
        nextPollAt: new Date(now + 10_000).toISOString(),
      })
      .mockImplementation(async (mission) => {
        mission.organizationContext = metricEvidence(2)
        return { status: "satisfied", reason: "Fresh actual revenue is 2 USD." }
      })
    const ports = { ...value.ports, observeMetrics }
    expect((await coordinate(value.mission, ports)).status).toBe("waiting")
    const startedAt = value.mission.observationStartedAt
    expect(value.mission.tasks[0]?.status).toBe("completed")
    vi.advanceTimersByTime(10_000)
    expect((await coordinate(value.mission, ports)).status).toBe("completed")
    expect(value.mission.observationStartedAt).toBe(startedAt)
    expect(stages(value.runAgent, "work")).toHaveLength(1)
    expect(stages(value.runAgent, "review")).toHaveLength(1)
    expect(observeMetrics).toHaveBeenCalledTimes(2)
  })

  it.each(["local-repair", "chief-repair", "chief-replan"])(
    "restarts business observation after %s and retains that new start on waiting-only resume",
    async (recovery) => {
      const value = fixture()
      value.mission.executionPolicy = executionPolicySchema.parse({})
      value.mission.maxRepairs = recovery === "local-repair" ? 1 : 0
      const targets = [{ name: "revenue", unit: "USD", direction: "increase" as const, target: 2 }]
      const policy = metricSourcePolicySchema.parse({
        sources: [{ id: "billing", name: "revenue", unit: "USD", url_env: "BILLING_ENDPOINT" }],
        observation_window_ms: 10_000,
      })
      value.mission.metricSourcePolicy = policy
      value.mission.operatingPolicy = { memory: false, reviewVendor: "prefer", metricTargets: targets }
      const base = value.runAgent.getMockImplementation()
      if (!base) throw new Error("Expected fixture Actor implementation")
      let workCount = 0
      let rejected = false
      value.runAgent.mockImplementation(async (actor, prompt, mission, stage, context) => {
        if (stage === "work" && ++workCount === 2) vi.advanceTimersByTime(20_000)
        if (stage === "supervise" && recovery === "chief-replan")
          return JSON.stringify({
            action: "replan",
            reason: "Keep original acceptance and fix the deliverable.",
            tasks: mission.plan?.tasks,
          })
        const response = await base(actor, prompt, mission, stage, context)
        if (stage === "final-review" && !rejected) {
          rejected = true
          const review = JSON.parse(response)
          review.passed = false
          review.findings = ["Repair the product copy before accepting the goal."]
          review.criteria[0].passed = false
          return JSON.stringify(review)
        }
        return response
      })
      let measurements = metricEvidence(2)
      const originalStarts: string[] = []
      const observeMetrics = vi.fn<NonNullable<ChiefPorts["observeMetrics"]>>().mockImplementation(async (mission) => {
        if (!mission.observationStartedAt) throw new Error("Expected saved observation start")
        originalStarts.push(mission.observationStartedAt)
        if (originalStarts.length === 1 || originalStarts.length === 3) {
          vi.advanceTimersByTime(10_000)
          measurements = metricEvidence(2)
        }
        mission.organizationContext = measurements
        const assessment = evaluateMetricObservation(
          policy,
          targets,
          measurements.metrics,
          mission.observationStartedAt,
          undefined,
          Date.now(),
        )
        return {
          status: assessment.status,
          reason: assessment.assessments.map((item) => item.reason).join("\n"),
          nextPollAt: assessment.nextPollAt,
        }
      })
      const ports = { ...value.ports, observeMetrics }
      expect((await coordinate(value.mission, ports)).status).toBe("waiting")
      expect(originalStarts).toHaveLength(2)
      expect(originalStarts[1]).not.toBe(originalStarts[0])
      expect(stages(value.runAgent, "work")).toHaveLength(2)
      expect((await coordinate(value.mission, ports)).status).toBe("completed")
      expect(originalStarts[2]).toBe(originalStarts[1])
      expect(stages(value.runAgent, "work")).toHaveLength(2)
    },
  )

  it("clears stalled supervision after real source evidence changes while files remain unchanged", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({})
    value.mission.plan = plan
    value.mission.goalBrief = brief
    if (value.mission.supervision) value.mission.supervision.originalAcceptance = onboarding.acceptance
    value.mission.tasks = [
      {
        id: "onboarding",
        reviewerId: "reviewer",
        status: "completed",
        attempts: 1,
        fingerprint: "same-deliverable",
        review: { passed: true, summary: "Inspected deliverable", findings: [] },
      },
    ]
    value.mission.initialFingerprint = "initial"
    value.mission.fingerprint = "same-deliverable"
    value.mutate("same-deliverable")
    value.mission.organizationContext = metricEvidence(1)
    executionState(value.mission).progressKey = progressKey(value.mission, "same-deliverable")
    if (value.mission.supervision) {
      value.mission.supervision.rounds = 3
      value.mission.supervision.stalledRounds = 3
    }
    value.verify.mockImplementationOnce(async () => {
      value.mission.organizationContext = metricEvidence(2)
      return { ok: false, output: "Metric observation changed; refine the deliverable." }
    })
    expect((await coordinate(value.mission, value.ports)).status).toBe("completed")
    expect(stages(value.runAgent, "supervise")).toHaveLength(1)
    expect(value.mission.supervision?.stalledRounds).toBe(0)
  })

  it("reserves and saves the Actor call limit before invoking another model and never resets it on resume", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({ maxRuns: 1 })
    expect((await coordinate(value.mission, value.ports)).status).toBe("paused")
    expect(value.mission.execution?.runsStarted).toBe(1)
    expect(value.snapshots.some((snapshot) => snapshot.execution?.runsStarted === 1)).toBe(true)
    expect(stages(value.runAgent, "plan")).toHaveLength(1)
    expect(stages(value.runAgent, "work")).toHaveLength(0)
    expect((await coordinate(value.mission, value.ports)).status).toBe("paused")
    expect(value.mission.execution?.runsStarted).toBe(1)
    expect(value.runAgent).toHaveBeenCalledTimes(1)
  })
})
