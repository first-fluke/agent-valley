import { describe, expect, it } from "vitest"
import { coordinate } from "./coordinator"
import { brief, fixture, plan } from "./goal-supervision.fixture"
import { validateMission } from "./schemas"
import type { ChiefStage, Mission } from "./types"

describe("Chief execution boundary characterization", () => {
  it("checkpoints stage inputs before dispatch and carries evidence through final approval and report", async () => {
    const { mission, ports, runAgent, verify, snapshots } = fixture()
    const originalRun = runAgent.getMockImplementation()
    const calls: {
      actor: string
      stage: ChiefStage
      prompt: string
      input: Mission
      saved?: Mission
      taskId?: string
    }[] = []
    const order: string[] = []
    runAgent.mockImplementation(async (...args) => {
      order.push(args[3])
      calls.push({
        actor: args[0].id,
        stage: args[3],
        prompt: args[1],
        input: structuredClone(args[2]),
        saved: structuredClone(snapshots.at(-1)),
        taskId: args[4]?.taskId,
      })
      return (await originalRun?.(...args)) ?? ""
    })
    verify.mockImplementation(async (input) => {
      order.push("verify")
      expect(snapshots.at(-1)).toMatchObject({
        status: "verifying",
        tasks: [{ id: "onboarding", status: "completed", review: { passed: true } }],
      })
      expect(input.verification).toBeUndefined()
      return { ok: true, output: "Onboarding acceptance check passed" }
    })

    await coordinate(mission, ports)

    expect(order).toEqual(["plan", "work", "review", "verify", "final-review"])
    expect(calls.map(({ actor, stage, taskId }) => ({ actor, stage, taskId }))).toEqual([
      { actor: "chief", stage: "plan", taskId: undefined },
      { actor: "worker", stage: "work", taskId: "onboarding" },
      { actor: "reviewer", stage: "review", taskId: "onboarding" },
      { actor: "chief", stage: "final-review", taskId: undefined },
    ])
    expect(calls.map(({ stage, saved }) => [stage, saved?.status, saved?.history.at(-1)?.stage])).toEqual([
      ["plan", "planning", "plan"],
      ["work", "executing", "work"],
      ["review", "reviewing", "review"],
      ["final-review", "reviewing", "final-review"],
    ])
    expect(calls[1]?.saved).toMatchObject({
      goalBrief: brief,
      plan,
      tasks: [{ id: "onboarding", status: "running", attempts: 1 }],
      supervision: { originalAcceptance: plan.tasks[0]?.acceptance },
    })
    expect(calls[2]?.saved?.tasks[0]?.output).toContain("Changed onboarding.ts")
    expect(calls[2]?.prompt).toContain("Changed onboarding.ts")
    expect(calls[3]?.input.verification).toEqual({
      ok: true,
      output: "Onboarding acceptance check passed",
      fingerprint: "change-1",
    })
    expect(calls[3]?.prompt).toContain("Onboarding acceptance check passed")
    expect(mission.finalReview?.passed).toBe(true)
    expect(mission.report).toBeDefined()
    expect(snapshots.at(-1)).toMatchObject({ status: "completed", report: mission.report })
  })

  it("saves rejected verification and reopened approvals before another Actor sees the repair", async () => {
    const { mission, ports, runAgent, verify, snapshots } = fixture()
    mission.maxRepairs = 1
    const originalRun = runAgent.getMockImplementation()
    const order: string[] = []
    let works = 0
    let verifications = 0
    runAgent.mockImplementation(async (...args) => {
      order.push(args[3])
      if (args[3] === "work" && ++works === 2) {
        expect(args[1]).toContain("FAIL onboarding acceptance: empty account cannot continue")
        expect(snapshots.at(-1)).toMatchObject({
          status: "executing",
          repairRound: 1,
          tasks: [{ id: "onboarding", status: "running", attempts: 2 }],
          verification: { ok: false, fingerprint: "change-1" },
        })
        const repair = snapshots.find((saved) => saved.history.at(-1)?.stage === "repair")
        expect(repair).toMatchObject({
          tasks: [{ id: "onboarding", status: "pending" }],
          verification: { ok: false },
        })
        expect(repair?.tasks[0]?.output).toBeUndefined()
        expect(repair?.finalReview).toBeUndefined()
      }
      return (await originalRun?.(...args)) ?? ""
    })
    verify.mockImplementation(async () => {
      order.push("verify")
      return ++verifications === 1
        ? { ok: false, output: "FAIL onboarding acceptance: empty account cannot continue" }
        : { ok: true, output: "Repaired onboarding acceptance passed" }
    })

    await coordinate(mission, ports)

    expect(order).toEqual(["plan", "work", "review", "verify", "work", "review", "verify", "final-review"])
    expect(mission.verification).toEqual({
      ok: true,
      output: "Repaired onboarding acceptance passed",
      fingerprint: "change-2",
    })
    expect(snapshots.at(-1)?.status).toBe("completed")
    expect(mission.supervision?.rounds).toBe(0)
  })

  it("reverifies a durable completed mission before renewing final approval and its report", async () => {
    const { mission, ports, runAgent, verify, snapshots } = fixture()
    await coordinate(mission, ports)
    const completed = snapshots.at(-1)
    if (!completed) throw new Error("Expected a completed mission checkpoint")
    const resumed = validateMission(structuredClone(completed))
    const originalRun = runAgent.getMockImplementation()
    const order: string[] = []
    runAgent.mockClear()
    verify.mockClear()
    runAgent.mockImplementation(async (...args) => {
      order.push(args[3])
      if (args[3] === "final-review") {
        expect(args[1]).toContain("Fresh verification after process restart")
        expect(snapshots.at(-1)?.verification?.output).toBe("Fresh verification after process restart")
      }
      return (await originalRun?.(...args)) ?? ""
    })
    verify.mockImplementation(async () => {
      order.push("verify")
      expect(snapshots.at(-1)?.status).toBe("verifying")
      expect(snapshots.at(-1)?.report).toBeUndefined()
      return { ok: true, output: "Fresh verification after process restart" }
    })

    await coordinate(resumed, ports)

    expect(order).toEqual(["verify", "final-review"])
    expect(resumed.tasks[0]?.attempts).toBe(1)
    expect(resumed.initialFingerprint).toBe("initial")
    expect(verify).toHaveBeenCalledOnce()
    expect(snapshots.at(-1)).toMatchObject({
      status: "completed",
      verification: { ok: true, output: "Fresh verification after process restart", fingerprint: "change-1" },
      report: resumed.report,
    })
  })
})
