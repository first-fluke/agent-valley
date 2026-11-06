import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { executionPolicySchema } from "./execution"
import { fixture } from "./goal-supervision.fixture"
import type { OperatingRun } from "./operations"
import { runStructuredStage } from "./structured-stage"

const now = Date.parse("2026-11-08T13:00:00Z")
const iso = (offset: number) => new Date(now + offset).toISOString()
const key = createHash("sha256").update("plan\0initial").digest("hex")
const oldPause =
  "The selected Chief Director could not complete plan: Agent timed out after 600s. Its goal, model and spent limits were retained; the outcome remains unresolved."

function legacy() {
  const { mission } = fixture()
  mission.timeoutSec = 1_800
  mission.executionPolicy = executionPolicySchema.parse({ maxRuns: 20, maxDurationSec: 3_600, maxRetries: 3 })
  mission.execution = { startedAt: iso(-1_200_000), runsStarted: 2, retries: 0 }
  mission.history = [
    { at: iso(-1_200_000), stage: "structured-stage-attempt", message: JSON.stringify({ key, attempts: 1 }) },
    { at: iso(-598_900), stage: "paused", message: oldPause },
    { at: iso(-500_000), stage: "structured-stage-attempt", message: JSON.stringify({ key, attempts: 2 }) },
    {
      at: iso(-10_000),
      stage: "structured-stage-invalid",
      message: JSON.stringify({ key, attempts: 2, reason: "Invalid JSON returned by the second plan call" }),
    },
  ]
  const failed: OperatingRun = {
    runId: "legacy-timeout",
    actorId: mission.chiefId,
    actorType: "codex",
    model: "operator-model",
    stage: "plan",
    startedAt: iso(-1_199_000),
    finishedAt: iso(-599_000),
    elapsedMs: 600_000,
    inputTokens: 100,
    outputTokens: 10,
    costUsd: 0.25,
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
      prompt: "Return the original plan",
      run,
      parse: JSON.parse,
      save,
    })
  return { mission, failed, run, save, invoke }
}

beforeEach(() => vi.useRealTimers())

describe("evidence-backed legacy planning timeout reservations", () => {
  it("releases only the confirmed pre-fix timeout while retaining a later malformed response and all spent budgets", async () => {
    const value = legacy()
    const original = structuredClone({
      execution: value.mission.execution,
      policy: value.mission.executionPolicy,
      runs: value.mission.operations?.runs,
    })
    expect(await value.invoke()).toEqual({ done: true })
    expect(value.run).toHaveBeenCalledOnce()
    expect(value.run.mock.calls[0]?.[0]).toContain("Invalid JSON returned by the second plan call")
    expect({
      execution: value.mission.execution,
      policy: value.mission.executionPolicy,
      runs: value.mission.operations?.runs,
    }).toEqual(original)
    expect(value.mission.timeoutSec).toBe(1_800)
    expect(value.mission.history.filter((entry) => entry.stage === "structured-stage-invalid")).toHaveLength(1)
    const releases = value.mission.history.filter((entry) => entry.stage === "structured-stage-transient")
    expect(releases).toHaveLength(1)
    expect(JSON.parse(releases[0]?.message ?? "{}")).toMatchObject({
      key,
      attempts: 1,
      legacyRunId: "legacy-timeout",
      reservationAt: iso(-1_200_000),
      pauseAt: iso(-598_900),
    })
    expect(value.save).toHaveBeenCalled()
  })

  it.each([
    "unknown",
    "running",
    "wrong-stage",
    "wrong-actor",
    "task-scoped",
    "missing-finish",
    "short-runtime",
    "ambiguous-runs",
    "malformed-response",
    "wrong-pause",
    "active-unrelated-run",
    "invalid-run-time",
  ])("does not release a reservation with insufficient evidence: %s", async (condition) => {
    const value = legacy()
    if (condition === "unknown") value.failed.executionState = "unknown"
    if (condition === "running") value.failed.executionState = "running"
    if (condition === "wrong-stage") value.failed.stage = "work"
    if (condition === "wrong-actor") value.failed.actorId = "worker"
    if (condition === "task-scoped") value.failed.taskId = "onboarding"
    if (condition === "missing-finish") value.failed.finishedAt = null
    if (condition === "short-runtime") value.failed.elapsedMs = 100
    if (condition === "invalid-run-time") value.failed.startedAt = "unknown"
    if (condition === "ambiguous-runs") value.mission.operations?.runs.push({ ...value.failed, runId: "ambiguous" })
    if (condition === "malformed-response")
      value.mission.history.splice(1, 0, {
        at: iso(-600_000),
        stage: "structured-stage-invalid",
        message: JSON.stringify({ key, attempts: 1, reason: "Malformed response" }),
      })
    if (condition === "wrong-pause") {
      const pause = value.mission.history[1]
      if (pause) pause.message = "A test timed out after 600s"
    }
    if (condition === "active-unrelated-run")
      value.mission.operations?.runs.push({
        ...value.failed,
        runId: "active",
        stage: "work",
        startedAt: iso(-100),
        finishedAt: null,
        executionState: "running",
      })
    await expect(value.invoke()).rejects.toThrow("two saved attempts")
    expect(value.run).not.toHaveBeenCalled()
    expect(value.mission.history.some((entry) => entry.stage === "structured-stage-transient")).toBe(false)
  })

  it("does not release the same legacy execution twice on another invocation", async () => {
    const value = legacy()
    await value.invoke()
    await expect(value.invoke()).rejects.toThrow("two saved attempts")
    expect(value.run).toHaveBeenCalledOnce()
    expect(value.mission.history.filter((entry) => entry.stage === "structured-stage-transient")).toHaveLength(1)
  })

  it("leaves multiple historical timeouts for explicit reconciliation", async () => {
    const value = legacy()
    const invalid = value.mission.history.pop()
    if (!invalid) throw new Error("Expected a saved second attempt")
    value.mission.history.push({ at: iso(-10_000), stage: "paused", message: oldPause })
    value.mission.operations?.runs.push({
      ...value.failed,
      runId: "second-timeout",
      startedAt: iso(-900_000),
      finishedAt: iso(-300_000),
    })
    await expect(value.invoke()).rejects.toThrow("two saved attempts")
    expect(value.run).not.toHaveBeenCalled()
    expect(value.mission.history.some((entry) => entry.stage === "structured-stage-transient")).toBe(false)
  })

  it("rejects a duplicated or unproved legacy release instead of restoring another JSON slot", async () => {
    const value = legacy()
    await value.invoke()
    const release = value.mission.history.find((entry) => entry.stage === "structured-stage-transient")
    if (!release) throw new Error("Expected a legacy timeout audit")
    value.mission.history.push(structuredClone(release))
    await expect(value.invoke()).rejects.toThrow(/legacy.*release|legacy.*history/i)
    expect(value.run).toHaveBeenCalledOnce()
  })
})
