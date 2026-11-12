import { mission as fixture } from "@agent-valley/core/chief/reports.fixture"
import type { Mission } from "@agent-valley/core/chief/types"
import { describe, expect, it } from "vitest"
import { assertContinuousDecisionRecovery, rearmContinuousDecision } from "../chief-continuous-recovery"

function pausedDecision(failureKind: NonNullable<Mission["execution"]>["failureKind"], reason: string): Mission {
  const decision = fixture()
  decision.status = "paused"
  decision.error = reason
  decision.history = []
  decision.execution = {
    startedAt: new Date().toISOString(),
    runsStarted: 3,
    retries: 0,
    pauseReason: reason,
    failureKind,
  }
  decision.executionPolicy = {
    maxParallel: 3,
    maxDurationSec: 3_600,
    maxRuns: 10,
    maxRetries: 3,
    retryDelayMs: 1_000,
    autoResume: true,
  }
  return decision
}

describe("operator recovery of a saved operation decision", () => {
  it("keeps an operator-interrupted decision closed to automatic continuation", () => {
    const decision = pausedDecision("interrupted", "Operation decision interrupted.")
    expect(() => assertContinuousDecisionRecovery(decision)).toThrow("Operation decision interrupted.")
  })

  it("reopens an operator-interrupted decision on explicit retry and keeps its spent usage", () => {
    const decision = pausedDecision("interrupted", "Operation decision interrupted.")
    rearmContinuousDecision(decision)
    expect(decision.status).toBe("planning")
    expect(decision.error).toBeUndefined()
    expect(decision.execution).toMatchObject({ runsStarted: 3, retries: 0 })
    expect(decision.execution?.failureKind).toBeUndefined()
    expect(decision.execution?.pauseReason).toBeUndefined()
    expect(decision.history.map((entry) => entry.stage)).toEqual(["continuous-decision-operator-resume"])
    expect(() => assertContinuousDecisionRecovery(decision)).not.toThrow()
  })

  it("refuses to reopen an interrupted decision whose call budget is spent", () => {
    const decision = pausedDecision("interrupted", "Operation decision interrupted.")
    if (decision.execution) decision.execution.runsStarted = 10
    expect(() => rearmContinuousDecision(decision)).toThrow("call limit")
    expect(decision.status).toBe("paused")
  })

  it("still refuses explicit retry for integrity and budget pauses", () => {
    for (const kind of ["integrity", "budget"] as const) {
      const decision = pausedDecision(kind, "Decision stage changed its saved charter.")
      expect(() => rearmContinuousDecision(decision)).toThrow("Operation --retry requires")
      expect(decision.status).toBe("paused")
    }
  })
})
