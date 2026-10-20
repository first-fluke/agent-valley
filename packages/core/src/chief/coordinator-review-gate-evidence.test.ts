import { describe, expect, it } from "vitest"
import type { RunAttempt } from "../domain/models"
import { automaticMissionRecovery, verifiedMissionEvidence } from "./continuous-recovery"
import { coordinate } from "./coordinator"
import { executionPolicySchema } from "./execution"
import { fixture, plan } from "./goal-supervision.fixture"
import { fallbackReport, renderReport, reportPrompt } from "./reports"
import type { Mission, Persona } from "./types"
import { finishOperatingRun, startOperatingRun } from "./usage"

const gates = [
  { id: "failure-paths", instructions: "Inspect failure-path acceptance evidence." },
  { id: "maintenance", instructions: "Inspect module boundaries and maintenance cost." },
]

function gatedFixture() {
  const value = fixture()
  value.mission.operatingPolicy = { reviewVendor: "off", memory: false, reviewGates: structuredClone(gates) }
  return value
}

function attempt(mission: Mission, id: string): RunAttempt {
  return {
    id,
    issueId: mission.id,
    workspacePath: mission.workspace.path,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    agentOutput: null,
  }
}

describe("review gate evidence boundaries", () => {
  it.each(["missing", "rejected", "stale"])(
    "requires Chief recovery and an incomplete report for %s gate evidence on a completed mission",
    async (damage) => {
      const { mission, ports } = gatedFixture()
      mission.executionPolicy = executionPolicySchema.parse({ maxRuns: 40 })
      await coordinate(mission, ports)
      expect(verifiedMissionEvidence(mission)).toBe(true)
      expect(automaticMissionRecovery(mission).retry).toBe(false)
      const incomplete = structuredClone(mission)
      if (damage === "missing") delete incomplete.gateReviews
      else {
        const review = incomplete.gateReviews?.[0]
        if (!review) throw new Error("Expected saved gate evidence")
        if (damage === "rejected")
          review.review = {
            passed: false,
            summary: "Acceptance evidence is incomplete.",
            findings: ["Inspect missing input."],
          }
        else review.fingerprint = "unverified-old-worktree"
      }
      const before = structuredClone(incomplete)

      expect(verifiedMissionEvidence(incomplete)).toBe(false)
      expect(automaticMissionRecovery(incomplete).retry).toBe(true)
      expect(fallbackReport(incomplete).remaining.some((reason) => reason.includes("추가 검토"))).toBe(true)
      expect(reportPrompt(incomplete)).toContain('"verdict":"incomplete"')
      expect(renderReport(incomplete)).toContain("**판정: 미완료**")
      expect(incomplete).toEqual(before)
    },
  )

  it.each(["budget", "checkpoint"])(
    "retains a successful first gate run when the second gate's %s reservation fails",
    async (failure) => {
      const { mission, ports, runAgent, verify } = gatedFixture()
      mission.operatingPolicy = {
        ...mission.operatingPolicy,
        reviewVendor: "prefer",
        readyActors: ["cursor", "claude"],
        memory: false,
      }
      mission.executionPolicy = executionPolicySchema.parse({ maxRuns: failure === "budget" ? 4 : 20 })
      const originalRun = runAgent.getMockImplementation()
      runAgent.mockImplementation(async (...args) => {
        const run = args[3] === "gate-review" ? attempt(args[2], "first-gate-native-run") : undefined
        const entry = run ? startOperatingRun(args[2], args[0], run, args[3], args[4]?.taskId) : undefined
        const output = (await originalRun?.(...args)) ?? ""
        if (run && entry)
          finishOperatingRun(args[2], entry, {
            ...run,
            finishedAt: new Date().toISOString(),
            exitCode: 0,
            agentOutput: output,
          })
        return output
      })
      const originalSave = ports.save
      let storageFailed = false
      ports.save = async (value) => {
        if (
          failure === "checkpoint" &&
          !storageFailed &&
          value.execution?.runsStarted === 5 &&
          value.operations?.reviewDecisions.at(-1)?.gateId === "maintenance"
        ) {
          storageFailed = true
          throw new Error("Fixture mission storage unavailable")
        }
        await originalSave(value)
      }

      if (failure === "budget") {
        await coordinate(mission, ports)
        expect(mission.status).toBe("paused")
        expect(mission.execution?.failureKind).toBe("budget")
      } else {
        await expect(coordinate(mission, ports)).rejects.toThrow("Actor budget reservation could not be saved")
        expect(mission.status).toBe("failed")
        expect(mission.execution?.failureKind).toBe("integrity")
      }

      expect(mission.operations?.runs).toHaveLength(1)
      expect(mission.operations?.runs[0]).toMatchObject({ runId: "first-gate-native-run", outcome: "passed" })
      expect(mission.operations?.reviewDecisions.filter((decision) => decision.gateId)).toMatchObject([
        { gateId: "failure-paths", outcome: "passed" },
        { gateId: "maintenance", outcome: "failed" },
      ])
      expect(mission.operations?.reviewDecisions.filter((decision) => !decision.gateId)).toMatchObject([
        { outcome: "passed" },
      ])
      expect(mission.gateReviews).toHaveLength(1)
      expect(mission.gateReviews?.[0]).toMatchObject({ gateId: "failure-paths", review: { passed: true } })
      expect(runAgent.mock.calls.filter((call) => call[3] === "gate-review")).toHaveLength(1)
      expect(verify).not.toHaveBeenCalled()
    },
  )

  it("bounds repeated verifier drift without an execution budget and retains the spent allowance on resume", async () => {
    const { mission, ports, runAgent, verify, mutate, snapshots } = gatedFixture()
    delete mission.supervision
    mission.maxRepairs = 0
    const originalRun = runAgent.getMockImplementation()
    runAgent.mockImplementation(async (...args) =>
      args[3] === "plan" ? JSON.stringify(plan) : ((await originalRun?.(...args)) ?? ""),
    )
    let verifications = 0
    verify.mockImplementation(async () => {
      mutate(`verification-generated-${++verifications}`)
      return { ok: true, output: "Acceptance passed, but its generated report changed again." }
    })

    await expect(coordinate(mission, ports)).rejects.toThrow("saved gate refresh allowance is exhausted")

    expect(mission.status).toBe("failed")
    expect(mission.gateReviewRefreshes).toBe(1)
    expect(verify).toHaveBeenCalledTimes(2)
    expect(runAgent.mock.calls.filter((call) => call[3] === "gate-review")).toHaveLength(4)
    expect(runAgent.mock.calls.filter((call) => call[3] === "work")).toHaveLength(1)
    expect(runAgent.mock.calls.some((call) => call[3] === "final-review" || call[3] === "report")).toBe(false)
    const saved = snapshots.at(-1)
    if (!saved) throw new Error("Expected bounded verifier drift checkpoint")
    const resumed = structuredClone(saved)

    await expect(coordinate(resumed, ports)).rejects.toThrow("saved gate refresh allowance is exhausted")

    expect(resumed.gateReviewRefreshes).toBe(1)
    expect(verify).toHaveBeenCalledTimes(3)
    expect(runAgent.mock.calls.filter((call) => call[3] === "gate-review")).toHaveLength(6)
    expect(runAgent.mock.calls.filter((call) => call[3] === "work")).toHaveLength(1)
    expect(resumed.executionPolicy).toBeUndefined()
  })

  it("uses the actual work vendor for required gate review while preserving ordinary task verdicts and gate IDs", async () => {
    const { mission, ports, runAgent } = gatedFixture()
    mission.operatingPolicy = {
      ...mission.operatingPolicy,
      reviewVendor: "require",
      readyActors: ["claude", "cursor"],
      memory: false,
    }
    const originalRun = runAgent.getMockImplementation()
    runAgent.mockImplementation(async (...args) => {
      if (args[3] === "work") {
        const nativeActor: Persona = { ...args[0], agentType: "claude" }
        const run = attempt(args[2], "routed-native-work")
        const entry = startOperatingRun(args[2], nativeActor, run, "work", args[4]?.taskId)
        const output = (await originalRun?.(...args)) ?? ""
        finishOperatingRun(args[2], entry, {
          ...run,
          finishedAt: new Date().toISOString(),
          exitCode: 0,
          agentOutput: output,
        })
        return output
      }
      if (args[3] === "review")
        return JSON.stringify({ passed: true, summary: "Ordinary task acceptance evidence passed.", findings: [] })
      return (await originalRun?.(...args)) ?? ""
    })

    await coordinate(mission, ports)

    expect(mission.status).toBe("completed")
    expect(mission.tasks[0]?.review?.summary).toBe("Ordinary task acceptance evidence passed.")
    const decisions = mission.operations?.reviewDecisions ?? []
    expect(decisions.filter((decision) => !decision.gateId)).toMatchObject([
      { outcome: "passed", workerActorType: "claude", reviewerActorType: "cursor", crossVendor: true },
    ])
    expect(decisions.filter((decision) => decision.gateId)).toMatchObject([
      {
        gateId: "failure-paths",
        outcome: "passed",
        workerActorType: "claude",
        reviewerActorType: "cursor",
        crossVendor: true,
      },
      {
        gateId: "maintenance",
        outcome: "passed",
        workerActorType: "claude",
        reviewerActorType: "cursor",
        crossVendor: true,
      },
    ])
    expect(
      runAgent.mock.calls.filter((call) => call[3] === "gate-review").every((call) => call[0].agentType === "cursor"),
    ).toBe(true)
    expect(mission.gateReviews?.every((entry) => entry.reviewerId === mission.tasks[0]?.reviewerId)).toBe(true)
  })
})
