import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RunAttempt } from "../domain/models"
import { AgentRunError } from "../domain/ports/agent-runner"
import { coordinate } from "./coordinator"
import { classifyFailure, executionPolicySchema, MissionPause } from "./execution"
import { fixture } from "./goal-supervision.fixture"
import type { OperatingRun } from "./operations"
import type { Mission } from "./types"

const now = Date.parse("2026-11-08T00:00:00Z")
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
})
afterEach(() => vi.useRealTimers())

function timeout(mission: Mission, unknown = false): AgentRunError {
  const at = new Date().toISOString()
  const id = `plan-timeout-${mission.execution?.runsStarted}`
  const attempt: RunAttempt = {
    id,
    issueId: mission.id,
    workspacePath: mission.workspace.path,
    startedAt: at,
    finishedAt: at,
    exitCode: 1,
    agentOutput: null,
  }
  const run: OperatingRun = {
    runId: id,
    stage: "plan",
    actorId: mission.chiefId,
    actorType: "codex",
    model: "operator-model",
    startedAt: at,
    finishedAt: at,
    elapsedMs: 600_000,
    inputTokens: 100,
    outputTokens: 10,
    costUsd: 0.25,
    outcome: "failed",
    executionState: unknown ? "unknown" : "settled",
    executionRecovery: "local-process",
  }
  mission.operations ??= { runs: [], routingEvidence: [], reviewDecisions: [] }
  mission.operations.runs.push(run)
  return new AgentRunError("Agent timed out after 600s", attempt, {
    code: "TIMEOUT",
    recoverable: true,
    outcomeUnknown: unknown,
  })
}

describe("native planning timeout recovery", () => {
  it.each(["Agent timed out after 600s", "Agent timed out after 0.5s"])(
    "classifies the native runner deadline as transient: %s",
    (message) => expect(classifyFailure(message)).toBe("provider"),
  )

  it.each([
    "test timed out after 600s",
    "Verification command timed out",
    "AssertionError: Agent timed out after 600s",
    "Agent timed out after 600s; cleanup remains uncertain",
  ])("keeps application test and uncertain-deadline messages out of provider retries: %s", (message) => {
    expect(classifyFailure(message)).toBe("implementation")
  })

  it("retries two settled planning timeouts from saved checkpoints without spending JSON correction attempts", async () => {
    const value = fixture()
    value.mission.timeoutSec = 600
    value.mission.executionPolicy = executionPolicySchema.parse({
      maxRetries: 3,
      retryDelayMs: 1_000,
      maxRuns: 10,
      maxDurationSec: 3_600,
      maxEstimatedCostUsd: 2,
    })
    const policy = structuredClone(value.mission.executionPolicy)
    const base = value.runAgent.getMockImplementation()
    let failures = 2
    value.runAgent.mockImplementation(async (...args) => {
      if (args[3] === "plan" && failures-- > 0) throw timeout(args[2])
      return (await base?.(...args)) ?? ""
    })
    let saved = value.mission
    for (const [retry, delay] of [
      [1, 1_000],
      [2, 2_000],
    ] as const) {
      expect((await coordinate(saved, value.ports)).status).toBe("waiting")
      expect(saved.execution).toMatchObject({ failureKind: "provider", retries: retry, runsStarted: retry })
      expect(saved.execution?.nextRunAt).toBe(new Date(Date.now() + delay).toISOString())
      expect(saved.supervision?.rounds).toBe(0)
      expect(value.runAgent.mock.calls.filter((call) => call[3] === "supervise")).toHaveLength(0)
      expect(value.snapshots.at(-1)?.execution?.failureKind).toBe("provider")
      saved = structuredClone(value.snapshots.at(-1) as Mission)
      vi.advanceTimersByTime(delay)
    }
    expect((await coordinate(saved, value.ports)).status).toBe("completed")
    expect(saved.id).toBe(value.mission.id)
    expect(saved.timeoutSec).toBe(600)
    expect(saved.executionPolicy).toEqual(policy)
    expect(saved.execution).toMatchObject({ retries: 2, startedAt: new Date(now).toISOString() })
    expect(saved.execution?.runsStarted).toBe(value.runAgent.mock.calls.length)
    expect(saved.operations?.runs.reduce((cost, run) => cost + (run.costUsd ?? 0), 0)).toBe(0.5)
    expect(
      value.runAgent.mock.calls
        .filter((call) => call[3] === "plan")
        .map((call) => [call[0].id, call[0].agentType, call[0].model]),
    ).toEqual([
      ["chief", "codex", "operator-model"],
      ["chief", "codex", "operator-model"],
      ["chief", "codex", "operator-model"],
    ])
    expect(saved.history.filter((entry) => entry.stage === "structured-stage-invalid")).toHaveLength(0)
  })

  it.each(["runs", "duration", "cost"] as const)(
    "retains the spent %s limit before a scheduled timeout retry",
    async (limit) => {
      const value = fixture()
      value.mission.executionPolicy = executionPolicySchema.parse({
        retryDelayMs: 1_000,
        ...(limit === "runs"
          ? { maxRuns: 1 }
          : limit === "duration"
            ? { maxDurationSec: 1 }
            : { maxEstimatedCostUsd: 0.25 }),
      })
      value.runAgent.mockImplementation(async (_actor, _prompt, mission) => {
        throw timeout(mission)
      })
      expect((await coordinate(value.mission, value.ports)).status).toBe("waiting")
      vi.advanceTimersByTime(1_000)
      expect((await coordinate(value.mission, value.ports)).status).toBe("paused")
      expect(value.mission.execution).toMatchObject({ failureKind: "budget", retries: 1, runsStarted: 1 })
      expect(value.runAgent).toHaveBeenCalledOnce()
    },
  )

  it("stops native planning retries at the saved retry limit before JSON correction is exhausted", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({ maxRetries: 2, retryDelayMs: 1_000 })
    const base = value.runAgent.getMockImplementation()
    value.runAgent.mockImplementation(async (...args) => {
      if (args[3] === "plan") throw timeout(args[2])
      return (await base?.(...args)) ?? ""
    })
    for (const delay of [1_000, 2_000]) {
      expect((await coordinate(value.mission, value.ports)).status).toBe("waiting")
      vi.advanceTimersByTime(delay)
    }
    await expect(coordinate(value.mission, value.ports)).rejects.toThrow("Agent timed out after 600s")
    expect(value.mission.status).toBe("failed")
    expect(value.mission.execution?.retries).toBe(2)
    expect(value.runAgent.mock.calls.filter((call) => call[3] === "plan")).toHaveLength(3)
    expect(value.mission.history.filter((entry) => entry.stage === "structured-stage-invalid")).toHaveLength(0)
    expect(value.mission.supervision?.rounds).toBe(0)
  })

  it("retains an earlier malformed response when a correction call times out and later resumes", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({ retryDelayMs: 1_000 })
    const base = value.runAgent.getMockImplementation()
    let plans = 0
    value.runAgent.mockImplementation(async (...args) => {
      if (args[3] === "plan") {
        plans += 1
        if (plans === 1) return "not JSON"
        if (plans === 2) throw timeout(args[2])
      }
      return (await base?.(...args)) ?? ""
    })
    expect((await coordinate(value.mission, value.ports)).status).toBe("waiting")
    vi.advanceTimersByTime(1_000)
    expect((await coordinate(value.mission, value.ports)).status).toBe("completed")
    const calls = value.runAgent.mock.calls.filter((call) => call[3] === "plan")
    expect(calls).toHaveLength(3)
    expect(calls[2]?.[1]).toContain("The previous response did not validate")
    expect(value.mission.history.filter((entry) => entry.stage === "structured-stage-invalid")).toHaveLength(1)
    const attempts = value.mission.history
      .filter((entry) => entry.stage === "structured-stage-attempt")
      .map((entry) => JSON.parse(entry.message).attempts)
    expect(attempts).toEqual([1, 2, 2])
  })

  it("keeps the two-response validation limit after a timeout consumed a provider retry", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({ retryDelayMs: 1_000 })
    const base = value.runAgent.getMockImplementation()
    let first = true
    value.runAgent.mockImplementation(async (...args) => {
      if (args[3] === "plan") {
        if (first) {
          first = false
          throw timeout(args[2])
        }
        return "not JSON"
      }
      return (await base?.(...args)) ?? ""
    })
    expect((await coordinate(value.mission, value.ports)).status).toBe("waiting")
    vi.advanceTimersByTime(1_000)
    await expect(coordinate(value.mission, value.ports)).rejects.toThrow("two saved attempts")
    expect(value.runAgent.mock.calls.filter((call) => call[3] === "plan")).toHaveLength(3)
    expect(value.mission.history.filter((entry) => entry.stage === "structured-stage-invalid")).toHaveLength(2)
    expect(value.mission.execution?.retries).toBe(1)
  })

  it("rejects a duplicated timeout release without another native call", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({ retryDelayMs: 1_000 })
    value.runAgent.mockImplementation(async (_actor, _prompt, mission) => {
      throw timeout(mission)
    })
    expect((await coordinate(value.mission, value.ports)).status).toBe("waiting")
    const release = value.mission.history.find((entry) => entry.stage === "structured-stage-transient")
    if (!release) throw new Error("Expected a settled timeout release record")
    value.mission.history.push(structuredClone(release))
    vi.advanceTimersByTime(1_000)
    await expect(coordinate(value.mission, value.ports)).rejects.toThrow("no matching reservation")
    expect(value.runAgent).toHaveBeenCalledOnce()
    expect(value.mission.execution?.failureKind).toBe("integrity")
  })

  it.each(["malformed-response", "wrong-reservation"])("rejects a timeout release after %s", async (condition) => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({ retryDelayMs: 1_000 })
    value.runAgent.mockImplementation(async (_actor, _prompt, mission) => {
      throw timeout(mission)
    })
    expect((await coordinate(value.mission, value.ports)).status).toBe("waiting")
    const releaseIndex = value.mission.history.findIndex((entry) => entry.stage === "structured-stage-transient")
    const release = value.mission.history[releaseIndex]
    if (!release) throw new Error("Expected a settled timeout release record")
    const record = JSON.parse(release.message)
    if (condition === "malformed-response")
      value.mission.history.splice(releaseIndex, 0, {
        at: release.at,
        stage: "structured-stage-invalid",
        message: JSON.stringify({
          key: record.key,
          attempts: record.attempts,
          reason: "The call returned malformed JSON",
        }),
      })
    else release.message = JSON.stringify({ ...record, reservationAt: "another-reservation" })
    vi.advanceTimersByTime(1_000)
    await expect(coordinate(value.mission, value.ports)).rejects.toThrow("no matching reservation")
    expect(value.runAgent).toHaveBeenCalledOnce()
    expect(value.mission.execution?.failureKind).toBe("integrity")
  })

  it("keeps an unknown timeout termination paused without a scheduled retry or another Actor", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({ retryDelayMs: 1_000 })
    value.runAgent.mockImplementation(async (_actor, _prompt, mission) => {
      throw timeout(mission, true)
    })
    expect((await coordinate(value.mission, value.ports)).status).toBe("paused")
    expect(value.mission.execution).toMatchObject({ failureKind: "unknown-effect", retries: 0, runsStarted: 1 })
    expect(value.mission.execution?.nextRunAt).toBeUndefined()
    vi.advanceTimersByTime(60_000)
    expect((await coordinate(value.mission, value.ports)).status).toBe("paused")
    expect(value.runAgent).toHaveBeenCalledOnce()
  })

  it("does not release JSON correction attempts for an unknown cleanup timeout", async () => {
    const value = fixture()
    value.mission.executionPolicy = executionPolicySchema.parse({})
    value.runAgent.mockRejectedValueOnce(new MissionPause("Agent cleanup timeout remains uncertain", "unknown-effect"))
    expect((await coordinate(value.mission, value.ports)).status).toBe("paused")
    expect(value.mission.history.some((entry) => entry.stage === "structured-stage-transient")).toBe(false)
  })
})
