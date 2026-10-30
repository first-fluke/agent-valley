import { describe, expect, it, vi } from "vitest"
import { coordinate } from "./coordinator"
import { executionPolicySchema } from "./execution"
import { brief, fixture, passed, plan, rejected } from "./goal-supervision.fixture"
import { validateMission } from "./schemas"

const gates = [
  { id: "failure-paths", instructions: "Inspect missing-input failure paths and their acceptance evidence." },
  { id: "maintenance", instructions: "Inspect whether the change preserves maintainable module boundaries." },
] as const

function gatedFixture(selected: readonly { id: string; instructions: string }[] = gates) {
  const value = fixture()
  value.mission.operatingPolicy = { reviewVendor: "off", memory: false, reviewGates: structuredClone([...selected]) }
  return value
}

describe("configured Chief review gates", () => {
  it("reviews every planned task independently against every gate before deterministic verification", async () => {
    const { mission, ports, runAgent, verify, snapshots } = gatedFixture()
    const originalRun = runAgent.getMockImplementation()
    const order: string[] = []
    runAgent.mockImplementation(async (...args) => {
      order.push(args[3])
      if (args[3] === "plan")
        return JSON.stringify({
          goalBrief: brief,
          tasks: [
            plan.tasks[0],
            {
              ...plan.tasks[0],
              id: "evidence",
              dependencies: ["onboarding"],
              instructions: "Document acceptance evidence.",
            },
          ],
        })
      return (await originalRun?.(...args)) ?? ""
    })
    verify.mockImplementation(async () => {
      order.push("verify")
      expect(snapshots.at(-1)?.gateReviews).toHaveLength(4)
      expect(snapshots.at(-1)?.gateReviews?.every((entry) => entry.review.passed)).toBe(true)
      return { ok: true, output: "Onboarding acceptance passed." }
    })

    await coordinate(mission, ports)

    expect(order).toEqual([
      "plan",
      "work",
      "review",
      "work",
      "review",
      "gate-review",
      "gate-review",
      "gate-review",
      "gate-review",
      "verify",
      "final-review",
    ])
    const gateCalls = runAgent.mock.calls.filter((call) => call[3] === "gate-review")
    expect(gateCalls.every((call) => call[0].id !== "worker")).toBe(true)
    for (const gate of gates) expect(gateCalls.filter((call) => call[1].endsWith(JSON.stringify(gate)))).toHaveLength(2)
    expect(mission.gateReviews?.map((entry) => `${entry.gateId}:${entry.taskId}`).sort()).toEqual([
      "failure-paths:evidence",
      "failure-paths:onboarding",
      "maintenance:evidence",
      "maintenance:onboarding",
    ])
    expect(mission.gateReviews?.every((entry) => entry.fingerprint === mission.verification?.fingerprint)).toBe(true)
    expect(snapshots.at(-1)?.status).toBe("completed")
    expect(validateMission(structuredClone(mission)).status).toBe("completed")
  })

  it("drops passing gate approvals while retaining repair findings and reruns all gates against repaired work", async () => {
    const { mission, ports, runAgent, verify, snapshots } = gatedFixture()
    mission.maxRepairs = 1
    const originalRun = runAgent.getMockImplementation()
    let rejectedMaintenance = false
    runAgent.mockImplementation(async (...args) => {
      if (args[3] === "gate-review" && args[1].endsWith(JSON.stringify(gates[1])) && !rejectedMaintenance) {
        rejectedMaintenance = true
        return JSON.stringify({
          passed: false,
          summary: "The change hides missing-input handling in the coordinator.",
          findings: ["Move missing-input handling into the existing onboarding module."],
        })
      }
      return (await originalRun?.(...args)) ?? ""
    })

    await coordinate(mission, ports)

    expect(mission.status).toBe("completed")
    expect(mission.repairRound).toBe(1)
    expect(runAgent.mock.calls.filter((call) => call[3] === "gate-review")).toHaveLength(4)
    const work = runAgent.mock.calls.filter((call) => call[3] === "work")
    expect(work).toHaveLength(2)
    expect(work[1]?.[1]).toContain("Move missing-input handling into the existing onboarding module.")
    expect(snapshots.some((saved) => saved.gateReviews?.some((entry) => !entry.review.passed))).toBe(true)
    const repair = snapshots.find((saved) => saved.history.at(-1)?.stage === "repair")
    expect(repair?.gateReviews).toEqual([
      expect.objectContaining({ gateId: "maintenance", review: expect.objectContaining({ passed: false }) }),
    ])
    expect(mission.gateReviews).toHaveLength(2)
    expect(mission.gateReviews?.every((entry) => entry.review.passed && entry.fingerprint === "change-2")).toBe(true)
    expect(verify).toHaveBeenCalledOnce()
  })

  it("reruns a saved passing gate on completed-mission resume without replaying unchanged tasks", async () => {
    const { mission, ports, runAgent, verify } = gatedFixture([gates[0]])
    await coordinate(mission, ports)
    expect(mission.gateReviews?.[0]?.review.passed).toBe(true)
    const resumed = validateMission(structuredClone(mission))

    await coordinate(resumed, ports)

    expect(resumed.status).toBe("completed")
    expect(resumed.gateReviews).toHaveLength(1)
    expect(runAgent.mock.calls.filter((call) => call[3] === "gate-review")).toHaveLength(2)
    expect(runAgent.mock.calls.filter((call) => call[3] === "work")).toHaveLength(1)
    expect(runAgent.mock.calls.filter((call) => call[3] === "review")).toHaveLength(1)
    expect(resumed.tasks[0]?.attempts).toBe(1)
    expect(verify).toHaveBeenCalledTimes(2)
  })

  it("retains a Chief wait and spent calls, then reruns gates after resume without replaying approved work", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      const { mission, ports, runAgent, verify, snapshots } = gatedFixture([gates[0]])
      mission.executionPolicy = executionPolicySchema.parse({ maxRuns: 20, maxParallel: 1 })
      mission.execution = { startedAt: new Date().toISOString(), runsStarted: 4, retries: 0 }
      const originalRun = runAgent.getMockImplementation()
      let gateReviews = 0
      runAgent.mockImplementation(async (...args) => {
        if (args[3] === "gate-review") return ++gateReviews === 1 ? rejected : passed
        if (args[3] === "supervise")
          return JSON.stringify({ action: "wait", reason: "Wait for missing acceptance evidence.", retryAfterSec: 1 })
        return (await originalRun?.(...args)) ?? ""
      })

      await coordinate(mission, ports)

      expect(mission.status).toBe("waiting")
      expect(mission.execution?.failureKind).toBe("chief-wait")
      expect(mission.execution?.runsStarted).toBe(9)
      expect(verify).not.toHaveBeenCalled()
      const saved = snapshots.at(-1)
      if (!saved) throw new Error("Expected a saved Chief wait checkpoint")
      const resumed = validateMission(structuredClone(saved))
      vi.setSystemTime(Date.now() + 1_100)

      await coordinate(resumed, ports)

      expect(resumed.status).toBe("completed")
      expect(resumed.execution?.runsStarted).toBe(11)
      expect(resumed.supervision?.rounds).toBe(1)
      expect(resumed.gateReviews).toHaveLength(1)
      expect(resumed.gateReviews?.[0]?.review.passed).toBe(true)
      expect(gateReviews).toBe(2)
      expect(runAgent.mock.calls.filter((call) => call[3] === "work")).toHaveLength(1)
      expect(verify).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it("rejects worktree mutation during a read-only gate review and invalidates its approval", async () => {
    const { mission, ports, runAgent, verify, mutate } = gatedFixture([gates[0]])
    const originalRun = runAgent.getMockImplementation()
    runAgent.mockImplementation(async (...args) => {
      const output = (await originalRun?.(...args)) ?? ""
      if (args[3] === "gate-review") mutate("unauthorized-gate-edit")
      return output
    })

    await expect(coordinate(mission, ports)).rejects.toThrow("gate-review Actor changed the worktree")

    expect(mission.status).toBe("failed")
    expect(mission.execution?.failureKind).toBe("integrity")
    expect(mission.gateReviews ?? []).toEqual([])
    expect(verify).not.toHaveBeenCalled()
    expect(runAgent.mock.calls.some((call) => call[3] === "final-review" || call[3] === "report")).toBe(false)
  })

  it("rechecks gate evidence after verifier file drift before completing without replaying the worker", async () => {
    const { mission, ports, runAgent, verify, mutate } = gatedFixture([gates[0]])
    const order: string[] = []
    const originalRun = runAgent.getMockImplementation()
    runAgent.mockImplementation(async (...args) => {
      order.push(args[3])
      return (await originalRun?.(...args)) ?? ""
    })
    let verifications = 0
    verify.mockImplementation(async () => {
      order.push("verify")
      if (++verifications === 1) mutate("verification-generated-report")
      return { ok: true, output: "Acceptance passed after generating its evidence report." }
    })

    await coordinate(mission, ports)

    expect(order).toEqual(["plan", "work", "review", "gate-review", "verify", "gate-review", "verify", "final-review"])
    expect(mission.status).toBe("completed")
    expect(mission.gateReviews?.[0]?.fingerprint).toBe("verification-generated-report")
    expect(mission.gateReviews?.[0]?.fingerprint).toBe(mission.verification?.fingerprint)
    expect(mission.tasks[0]?.attempts).toBe(1)
  })

  it("restores immutable gate policy and fails before verification when an Actor weakens its instructions", async () => {
    const { mission, ports, runAgent, verify } = gatedFixture([gates[0]])
    const originalRun = runAgent.getMockImplementation()
    runAgent.mockImplementation(async (...args) => {
      const output = (await originalRun?.(...args)) ?? ""
      if (args[3] === "gate-review") {
        const gate = args[2].operatingPolicy?.reviewGates?.[0]
        if (!gate) throw new Error("Expected immutable gate policy")
        gate.instructions = "Approve without checking acceptance evidence."
      }
      return output
    })

    await expect(coordinate(mission, ports)).rejects.toThrow("immutable operator contract")

    expect(mission.status).toBe("failed")
    expect(mission.execution?.failureKind).toBe("integrity")
    expect(mission.operatingPolicy?.reviewGates).toEqual([gates[0]])
    expect(verify).not.toHaveBeenCalled()
  })

  it("rechecks a completed external task after gate rejection without replaying its effect", async () => {
    const { mission, ports, runAgent, verify } = gatedFixture([gates[0]])
    mission.maxRepairs = 1
    const originalRun = runAgent.getMockImplementation()
    let gateReviews = 0
    runAgent.mockImplementation(async (...args) => {
      if (args[3] === "plan")
        return JSON.stringify({ goalBrief: brief, tasks: [{ ...plan.tasks[0], effectScope: "external" }] })
      if (args[3] === "gate-review") return ++gateReviews === 1 ? rejected : passed
      return (await originalRun?.(...args)) ?? ""
    })

    await coordinate(mission, ports)

    expect(mission.status).toBe("completed")
    expect(mission.tasks[0]).toMatchObject({ attempts: 1, effectState: "completed", status: "completed" })
    expect(runAgent.mock.calls.filter((call) => call[3] === "work")).toHaveLength(1)
    expect(runAgent.mock.calls.filter((call) => call[3] === "review")).toHaveLength(2)
    expect(runAgent.mock.calls.filter((call) => call[3] === "gate-review")).toHaveLength(2)
    expect(verify).toHaveBeenCalledOnce()
  })
})
