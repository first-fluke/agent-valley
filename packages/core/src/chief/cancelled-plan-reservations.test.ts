import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { coordinate } from "./coordinator"
import { executionPolicySchema, MissionPause } from "./execution"
import { fixture } from "./goal-supervision.fixture"
import type { OperatingRun } from "./operations"
import { serviceShutdownPause } from "./service-shutdown"
import { runStructuredStage } from "./structured-stage"

const now = Date.parse("2026-11-08T13:00:00Z")
const iso = (offset: number) => new Date(now + offset).toISOString()
const key = createHash("sha256").update("plan\0initial").digest("hex")
const operatorStop =
  "Operator stopped the order. Its checks and worktree were retained; repair any interrupted effects before resuming with --retry."
const coordinatorStop = "Mission interrupted. Its checks, budget and child workspace records were retained for resume."

function cancelled() {
  const value = fixture()
  const { mission } = value
  mission.executionPolicy = executionPolicySchema.parse({ maxRuns: 200, maxDurationSec: 3_600, maxRetries: 3 })
  mission.execution = { startedAt: iso(-500_000), runsStarted: 8, retries: 2 }
  mission.history = [
    { at: iso(-400_000), stage: "structured-stage-attempt", message: JSON.stringify({ key, attempts: 1 }) },
    { at: iso(-200_000), stage: "paused", message: operatorStop },
    { at: iso(-100_000), stage: "structured-stage-attempt", message: JSON.stringify({ key, attempts: 2 }) },
    {
      at: iso(-50_000),
      stage: "structured-stage-invalid",
      message: JSON.stringify({ key, attempts: 2, reason: "Later malformed response" }),
    },
  ]
  const failed: OperatingRun = {
    runId: "cancelled-native-plan",
    actorId: mission.chiefId,
    actorType: "codex",
    model: "operator-model",
    stage: "plan",
    startedAt: iso(-399_000),
    finishedAt: iso(-200_100),
    elapsedMs: 198_900,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    outcome: "failed",
    executionState: "settled",
    executionRecovery: "local-process",
  }
  mission.operations = { runs: [failed], routingEvidence: [], reviewDecisions: [] }
  const run = vi.fn(async (_prompt: string) => '{"done":true}')
  const save = vi.fn(async () => {})
  const invoke = () =>
    runStructuredStage({
      mission,
      stage: "plan",
      scopeKey: "initial",
      prompt: "Original plan",
      run,
      parse: JSON.parse,
      save,
    })
  return { ...value, failed, run, save, invoke }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
})
afterEach(() => vi.useRealTimers())

describe("settled cancelled planning reservations", () => {
  it.each([operatorStop, coordinatorStop, serviceShutdownPause().message])(
    "reconciles the unused response slot from exact cancellation and native termination proof: %s",
    async (message) => {
      const value = cancelled()
      const pause = value.mission.history[1]
      if (!pause) throw new Error("Expected a cancellation checkpoint")
      pause.message = message
      const spent = structuredClone({
        execution: value.mission.execution,
        policy: value.mission.executionPolicy,
        runs: value.mission.operations?.runs,
      })

      expect(await value.invoke()).toEqual({ done: true })

      expect(value.run).toHaveBeenCalledOnce()
      expect(value.run.mock.calls[0]?.[0]).toContain("Later malformed response")
      expect({
        execution: value.mission.execution,
        policy: value.mission.executionPolicy,
        runs: value.mission.operations?.runs,
      }).toEqual(spent)
      const releases = value.mission.history.filter((entry) => entry.stage === "structured-stage-transient")
      expect(releases).toHaveLength(1)
      expect(JSON.parse(releases[0]?.message ?? "{}")).toMatchObject({
        key,
        attempts: 1,
        cancelledRunId: value.failed.runId,
        reservationAt: iso(-400_000),
        pauseAt: iso(-200_000),
      })
      await expect(value.invoke()).rejects.toThrow("two saved attempts")
      expect(value.run).toHaveBeenCalledOnce()
    },
  )

  it.each([
    "generic-interruption",
    "unknown",
    "running",
    "not-native",
    "passed",
    "wrong-actor",
    "wrong-stage",
    "task-run",
    "missing-finish",
    "outside-reservation",
    "ambiguous-runs",
    "malformed-before-pause",
    "unknown-effect",
    "running-effect",
    "completed-plan",
    "active-unrelated-run",
    "reconciled-after-pause",
  ])("retains the response allowance when proof is incomplete: %s", async (condition) => {
    const value = cancelled()
    if (condition === "generic-interruption") {
      const pause = value.mission.history[1]
      if (pause) pause.message = "Interrupted"
    }
    if (condition === "unknown") value.failed.executionState = "unknown"
    if (condition === "running") value.failed.executionState = "running"
    if (condition === "not-native") value.failed.executionRecovery = "reconcile"
    if (condition === "passed") value.failed.outcome = "passed"
    if (condition === "wrong-actor") value.failed.actorId = "worker"
    if (condition === "wrong-stage") value.failed.stage = "work"
    if (condition === "task-run") value.failed.taskId = "onboarding"
    if (condition === "missing-finish") value.failed.finishedAt = null
    if (condition === "outside-reservation") value.failed.startedAt = iso(-401_000)
    if (condition === "ambiguous-runs") value.mission.operations?.runs.push({ ...value.failed, runId: "another" })
    if (condition === "malformed-before-pause")
      value.mission.history.splice(1, 0, {
        at: iso(-300_000),
        stage: "structured-stage-invalid",
        message: JSON.stringify({ key, attempts: 1 }),
      })
    if (condition === "unknown-effect" || condition === "running-effect")
      value.mission.tasks.push({
        id: "external",
        reviewerId: "reviewer",
        status: "pending",
        attempts: 1,
        effectState: condition === "unknown-effect" ? "unknown" : "running",
      })
    if (condition === "completed-plan") value.mission.plan = { tasks: [] }
    if (condition === "active-unrelated-run")
      value.mission.operations?.runs.push({
        ...value.failed,
        runId: "unsettled-worker",
        stage: "work",
        executionState: "running",
        finishedAt: null,
      })
    if (condition === "reconciled-after-pause") value.failed.finishedAt = iso(-199_000)

    await expect(value.invoke()).rejects.toThrow("two saved attempts")
    expect(value.run).not.toHaveBeenCalled()
    expect(value.mission.history.some((entry) => entry.stage === "structured-stage-transient")).toBe(false)
  })

  it("reconciles consecutive proven cancellations without releasing either native call twice", async () => {
    const value = cancelled()
    value.mission.history.pop()
    value.mission.history.push({ at: iso(-10_000), stage: "paused", message: operatorStop })
    value.mission.operations?.runs.push({
      ...value.failed,
      runId: "second-cancelled-plan",
      startedAt: iso(-99_000),
      finishedAt: iso(-10_100),
    })

    expect(await value.invoke()).toEqual({ done: true })

    expect(value.run).toHaveBeenCalledOnce()
    expect(value.run.mock.calls[0]?.[0]).toBe("Original plan")
    const releases = value.mission.history.filter((entry) => entry.stage === "structured-stage-transient")
    expect(releases).toHaveLength(2)
    value.mission.history.push({
      at: iso(1),
      stage: "structured-stage-invalid",
      message: JSON.stringify({ key, attempts: 1, reason: "Malformed first returned response" }),
    })
    value.run.mockResolvedValueOnce("not JSON")
    await expect(value.invoke()).rejects.toThrow("two saved attempts")
    expect(value.mission.history.filter((entry) => entry.stage === "structured-stage-transient")).toHaveLength(2)
    expect(value.run).toHaveBeenCalledTimes(2)
  })

  it.each(["duplicate", "wrong-reservation", "invalid-before-pause"])(
    "rejects unproved cancellation release history: %s",
    async (condition) => {
      const value = cancelled()
      await value.invoke()
      const release = value.mission.history.find((entry) => entry.stage === "structured-stage-transient")
      if (!release) throw new Error("Expected a proven cancellation release")
      if (condition === "duplicate") value.mission.history.push(structuredClone(release))
      if (condition === "wrong-reservation")
        release.message = JSON.stringify({ ...JSON.parse(release.message), reservationAt: iso(-399_000) })
      if (condition === "invalid-before-pause")
        value.mission.history.splice(1, 0, {
          at: iso(-300_000),
          stage: "structured-stage-invalid",
          message: JSON.stringify({ key, attempts: 1, reason: "The response was already returned" }),
        })
      await expect(value.invoke()).rejects.toThrow("unique settled execution proof")
      expect(value.run).toHaveBeenCalledOnce()
    },
  )

  it("resumes the same coordinated plan after a settled cancellation without rerouting or resetting spent calls", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({ maxRuns: 200, maxDurationSec: 3_600 })
    const controller = new AbortController()
    const base = value.runAgent.getMockImplementation()
    value.runAgent.mockImplementationOnce(async (_actor, _prompt, mission) => {
      const at = new Date().toISOString()
      mission.operations = {
        runs: [
          {
            runId: "cancelled",
            stage: "plan",
            actorId: mission.chiefId,
            actorType: "codex",
            model: "operator-model",
            startedAt: at,
            finishedAt: at,
            elapsedMs: 0,
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
            outcome: "failed",
            executionState: "settled",
            executionRecovery: "local-process",
          },
        ],
        routingEvidence: [],
        reviewDecisions: [],
      }
      controller.abort(new MissionPause(operatorStop, "interrupted"))
      throw controller.signal.reason
    })
    expect((await coordinate(value.mission, { ...value.ports, signal: controller.signal })).status).toBe("paused")
    expect(value.mission.execution?.runsStarted).toBe(1)
    expect(value.mission.plan).toBeUndefined()
    value.runAgent.mockImplementation(base ?? (async () => ""))

    expect((await coordinate(value.mission, value.ports)).status).toBe("completed")

    const plans = value.runAgent.mock.calls.filter((call) => call[3] === "plan")
    expect(plans).toHaveLength(2)
    expect(plans.map((call) => [call[0].id, call[0].agentType, call[0].model])).toEqual([
      ["chief", "codex", "operator-model"],
      ["chief", "codex", "operator-model"],
    ])
    expect(value.mission.execution?.runsStarted).toBe(value.runAgent.mock.calls.length)
    expect(value.mission.operations?.runs[0]?.costUsd).toBeNull()
    expect(value.mission.history.filter((entry) => entry.stage === "structured-stage-invalid")).toHaveLength(0)
    const attempts = value.mission.history
      .filter((entry) => entry.stage === "structured-stage-attempt")
      .map((entry) => JSON.parse(entry.message).attempts)
    expect(attempts).toEqual([1, 1])
  })
})
