import { describe, expect, it } from "vitest"
import { automaticMissionRecovery, verifiedMissionEvidence } from "./continuous-recovery"
import { executionPolicySchema } from "./execution"
import { mission as fixture } from "./reports.fixture"
import type { Mission } from "./types"

const now = Date.parse("2026-10-06T00:00:00.000Z")
function checkpoint() {
  const mission = fixture()
  mission.status = "paused"
  mission.executionPolicy = executionPolicySchema.parse({ maxRuns: 10 })
  mission.execution = { startedAt: new Date(now - 1000).toISOString(), runsStarted: 4, retries: 1 }
  mission.supervision = {
    maxRounds: 5,
    rounds: 2,
    stalledRounds: 1,
    decisions: [],
    originalAcceptance: mission.supervision?.originalAcceptance,
    pendingRecovery: { reason: "Known worker authentication failure" },
  }
  return {
    ...mission,
    execution: mission.execution,
    executionPolicy: mission.executionPolicy,
    supervision: mission.supervision,
  }
}

describe("automatic Chief recovery eligibility", () => {
  it("permits the saved Chief to resolve a known worker failure without mutating counters or identity", () => {
    const mission = checkpoint()
    mission.execution.failureKind = "authentication"
    const before = structuredClone(mission)
    expect(automaticMissionRecovery(mission, now)).toEqual({
      retry: true,
      reason: "Known worker authentication failure",
    })
    expect(mission).toEqual(before)
  })

  it.each(["budget", "interrupted", "unknown-effect", "chief-unavailable", "integrity"] as const)(
    "protects %s without automatic replay",
    (kind) => {
      const mission = checkpoint()
      mission.execution.failureKind = kind
      expect(automaticMissionRecovery(mission, now).retry).toBe(false)
    },
  )

  it("protects unknown native usage, exhausted calls, duration, rounds and disabled recovery", () => {
    const mission = checkpoint()
    mission.executionPolicy.maxRuns = 4
    expect(automaticMissionRecovery(mission, now).retry).toBe(false)
    mission.executionPolicy.maxRuns = 10
    mission.executionPolicy.maxDurationSec = 1
    expect(automaticMissionRecovery(mission, now).retry).toBe(false)
    mission.executionPolicy.maxDurationSec = 100
    mission.supervision.rounds = 5
    expect(automaticMissionRecovery(mission, now).retry).toBe(false)
    mission.supervision.rounds = 2
    mission.executionPolicy.autoResume = false
    expect(automaticMissionRecovery(mission, now).retry).toBe(false)
  })

  it("permits only a saved read-only Chief wait to observe an unknown effect again", () => {
    const mission = checkpoint()
    const task = mission.tasks[0]
    if (!task) throw new Error("Expected task checkpoint")
    task.effectState = "unknown"
    mission.status = "waiting"
    mission.execution.failureKind = "chief-wait"
    mission.execution.nextRunAt = new Date(now + 5000).toISOString()
    mission.supervision.decisions.push({
      round: 2,
      at: new Date(now).toISOString(),
      action: "wait",
      reason: "Observe destination again",
      fingerprint: "saved",
      retryAfterSec: 5,
    })
    expect(automaticMissionRecovery(mission, now)).toMatchObject({
      retry: true,
      waitUntil: mission.execution.nextRunAt,
    })
    delete mission.execution.nextRunAt
    expect(automaticMissionRecovery(mission, now).retry).toBe(false)
    mission.execution.nextRunAt = new Date(now + 5000).toISOString()
    mission.execution.failureKind = "provider"
    expect(automaticMissionRecovery(mission, now).retry).toBe(false)
    expect(mission.tasks[0]?.effectState).toBe("unknown")
  })

  it("fails closed for malformed Chief stop timestamps and legacy contract/checkpoint failures", () => {
    const mission = checkpoint()
    mission.execution.interventionAt = new Date(now + 1000).toISOString()
    mission.supervision.decisions.push({
      round: 2,
      at: "invalid",
      action: "stop",
      reason: "Unresolved",
      fingerprint: "saved",
    })
    expect(automaticMissionRecovery(mission, now).retry).toBe(false)
    mission.supervision.decisions = []
    for (const reason of [
      "Mission goal, success criteria or operator verification changed. Restore the immutable operator contract.",
      "Actor budget reservation could not be saved. Restore writable mission storage before resuming.",
    ]) {
      mission.error = reason
      expect(automaticMissionRecovery(mission, now).retry).toBe(false)
    }
  })

  it("binds completion to completed reviewed tasks and the recorded final worktree fingerprint", () => {
    const mission = checkpoint()
    expect(verifiedMissionEvidence(mission)).toBe(true)
    const task = mission.tasks[0]
    if (!task) throw new Error("Expected task checkpoint")
    task.status = "pending"
    expect(verifiedMissionEvidence(mission)).toBe(false)
    task.status = "completed"
    task.review = { passed: false, summary: "Failed", findings: ["Unresolved"] }
    expect(verifiedMissionEvidence(mission)).toBe(false)
    task.review.passed = true
    task.review.findings = []
    mission.fingerprint = "different"
    expect(verifiedMissionEvidence(mission)).toBe(false)
    mission.verification = { ok: true, fingerprint: "different" }
    expect(verifiedMissionEvidence(mission)).toBe(true)
  })

  it("retains Chief stop and hard integrity failures while routing only unverified completed evidence", () => {
    const mission = checkpoint()
    mission.supervision.decisions.push({
      round: 2,
      at: new Date(now).toISOString(),
      action: "stop",
      reason: "Required evidence is unavailable",
      fingerprint: "saved",
    })
    expect(automaticMissionRecovery(mission, now).retry).toBe(false)
    mission.supervision.decisions = []
    mission.error = "Decision Actor changed the worktree during a read-only stage"
    expect(automaticMissionRecovery(mission, now).retry).toBe(false)
    delete mission.error
    mission.status = "completed"
    mission.verification = { ok: true, fingerprint: "changed" }
    mission.finalReview = { ...mission.finalReview, passed: true, summary: "Verified", findings: [] }
    expect(automaticMissionRecovery(mission, now).retry).toBe(false)
    mission.finalReview.passed = false
    expect(automaticMissionRecovery(mission, now).retry).toBe(true)
  })

  it.each([
    (mission: Mission) => {
      delete mission.plan
    },
    (mission: Mission) => {
      mission.tasks = []
    },
    (mission: Mission) => {
      delete mission.fingerprint
    },
    (mission: Mission) => {
      mission.verification = { ok: true, fingerprint: "" }
    },
    (mission: Mission) => {
      delete mission.tasks[0]?.fingerprint
    },
    (mission: Mission) => {
      delete mission.finalReview?.criteria
    },
    (mission: Mission) => {
      const task = mission.plan?.tasks[0]
      const state = mission.tasks[0]
      if (!task || !state || !mission.plan) throw new Error("Expected plan evidence")
      mission.plan.tasks.push({ ...task })
      mission.tasks.push({ ...state })
    },
    (mission: Mission) => {
      const state = mission.tasks[0]
      if (!state) throw new Error("Expected task evidence")
      state.id = "orphan"
    },
    (mission: Mission) => {
      const task = mission.plan?.tasks[0]
      const state = mission.tasks[0]
      if (!task || !state) throw new Error("Expected independent review evidence")
      state.reviewerId = task.personaId
    },
  ])("rejects incomplete completion evidence %# while retaining the original checkpoint", (removeEvidence) => {
    const mission = checkpoint()
    removeEvidence(mission)
    const before = structuredClone(mission)
    expect(verifiedMissionEvidence(mission)).toBe(false)
    expect(mission).toEqual(before)
  })
})
