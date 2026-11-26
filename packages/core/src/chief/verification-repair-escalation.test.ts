import { describe, expect, it, vi } from "vitest"
import { coordinate } from "./coordinator"
import { verifyMission } from "./coordinator-completion-stages"
import type { CoordinatorContext } from "./coordinator-stages"
import { brief, fixture, passed, plan } from "./goal-supervision.fixture"
import type { Mission } from "./types"

function makeContext(missionOverrides: Partial<Mission> = {}) {
  const { mission, ports } = fixture()
  Object.assign(mission, missionOverrides)
  const requestRecovery = vi.fn(async () => {})
  const requestRepair = vi.fn(async () => {})
  const save = vi.fn(async () => {})
  const checkpoint = {
    transition: vi.fn(async () => {}),
    record: vi.fn(async () => {}),
    persist: vi.fn(async () => {}),
  }
  const context: CoordinatorContext = {
    mission,
    ports,
    operatorGoal: mission.goal,
    operatorVerify: mission.verifyCommand,
    contract: { pin: vi.fn(), assert: vi.fn() },
    checkpoint: checkpoint as unknown as CoordinatorContext["checkpoint"],
    run: vi.fn() as unknown as CoordinatorContext["run"],
    generateReport: vi.fn() as unknown as CoordinatorContext["generateReport"],
    requestRecovery,
    requestRepair,
    persona: vi.fn() as unknown as CoordinatorContext["persona"],
    save,
    assertContract: vi.fn(),
    checkAbort: vi.fn(),
    protectedFailure: vi.fn(() => false),
    invalidate: vi.fn(),
  }
  return { context, requestRecovery, requestRepair, mission, ports }
}

describe("repeated verification failure escalation to Chief supervise", () => {
  it("escalates to requestRecovery on repeated identical verification output failure", async () => {
    const { context, requestRepair, requestRecovery, mission, ports } = makeContext({
      supervision: { maxRounds: 5, rounds: 0, stalledRounds: 0, decisions: [] },
    })
    ports.verify = vi.fn().mockResolvedValue({ ok: false, output: "FAIL: missing assertion in tests" })

    // First failure -> repairs normally
    const t1 = await verifyMission(context)
    expect(t1).toEqual({ kind: "next", stage: "tasks" })
    expect(requestRepair).toHaveBeenCalledOnce()
    expect(requestRecovery).not.toHaveBeenCalled()
    expect(mission.supervision?.verificationFailureKey).toBeDefined()

    // Second failure with exact same output -> escalates to requestRecovery immediately
    const t2 = await verifyMission(context)
    expect(t2).toEqual({ kind: "next", stage: "tasks" })
    expect(requestRecovery).toHaveBeenCalledOnce()
    expect(requestRepair).toHaveBeenCalledOnce() // Not called again on 2nd failure
    expect(mission.supervision?.verificationFailureKey).toBeUndefined()
  })

  it("escalates based on deterministic checkSha256 values in goalVerification", async () => {
    const { context, requestRepair, requestRecovery, mission, ports } = makeContext({
      supervision: { maxRounds: 5, rounds: 0, stalledRounds: 0, decisions: [] },
      plan: {
        tasks: [
          {
            id: "task-qa",
            title: "QA task",
            personaId: "worker",
            instructions: "Deliver .arc-verify/qa.md",
            acceptance: [".arc-verify/qa.md exists"],
            dependencies: [],
          },
        ],
      },
      tasks: [
        {
          id: "task-qa",
          reviewerId: "reviewer",
          status: "completed",
          attempts: 1,
          changeSet: {
            version: 1,
            inputTree: "0".repeat(40),
            deliveryTree: "1".repeat(40),
            files: [{ path: ".arc-verify/qa.md", status: "added", size: 10, sha256: "a".repeat(64) }],
            diff: "",
            diffTruncated: false,
          },
        },
      ],
    })

    const failingEvidence = [
      {
        criterion: "QA check",
        passed: false,
        checks: [
          {
            checkSha256: "deadbeef".repeat(8),
            kind: "file" as const,
            passed: false,
            summary: "FAIL: missing TRF-019",
            path: ".arc-verify/qa.md",
          },
        ],
      },
    ]

    ports.verify = vi.fn().mockImplementation(async (m) => {
      m.goalVerification = {
        ok: false,
        output: "FAIL: missing TRF-019",
        contractSha256: "feedface".repeat(8),
        checkedAt: new Date().toISOString(),
        evidence: failingEvidence,
      }
      return { ok: false, output: "FAIL: missing TRF-019" }
    })

    // First attempt -> routes repair to task-qa
    await verifyMission(context)
    expect(requestRepair).toHaveBeenCalledOnce()
    expect(requestRecovery).not.toHaveBeenCalled()
    expect(mission.supervision?.verificationFailureKey).toBe(`task-qa:${"deadbeef".repeat(8)}`)

    // Second attempt with exact same failing check on task-qa -> escalates to recovery
    await verifyMission(context)
    expect(requestRecovery).toHaveBeenCalledWith("FAIL: missing TRF-019", "task-qa")
  })

  it("does not escalate when verification failure changes between rounds", async () => {
    const { context, requestRepair, requestRecovery, ports } = makeContext({
      supervision: { maxRounds: 5, rounds: 0, stalledRounds: 0, decisions: [] },
    })

    ports.verify = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, output: "FAIL: first reason" })
      .mockResolvedValueOnce({ ok: false, output: "FAIL: second different reason" })

    // Round 1
    await verifyMission(context)
    expect(requestRepair).toHaveBeenCalledTimes(1)
    expect(requestRecovery).not.toHaveBeenCalled()

    // Round 2 with different reason
    await verifyMission(context)
    expect(requestRepair).toHaveBeenCalledTimes(2)
    expect(requestRecovery).not.toHaveBeenCalled()
  })

  it("clears verificationFailureKey when verifyMission passes", async () => {
    const { context, mission, ports } = makeContext({
      supervision: { maxRounds: 5, rounds: 0, stalledRounds: 0, decisions: [] },
    })

    ports.verify = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, output: "FAIL: test failure" })
      .mockResolvedValueOnce({ ok: true, output: "PASS" })

    await verifyMission(context)
    expect(mission.supervision?.verificationFailureKey).toBeDefined()

    await verifyMission(context)
    expect(mission.supervision?.verificationFailureKey).toBeUndefined()
  })

  it("does not escalate when supervision is not enabled", async () => {
    const { context, requestRepair, requestRecovery, ports } = makeContext({
      supervision: undefined,
    })

    ports.verify = vi.fn().mockResolvedValue({ ok: false, output: "FAIL: identical" })

    await verifyMission(context)
    await verifyMission(context)

    expect(requestRepair).toHaveBeenCalledTimes(2)
    expect(requestRecovery).not.toHaveBeenCalled()
  })

  it("escalates early in coordinate() rather than burning all maxRepairs rounds", async () => {
    const { mission, ports, runAgent, verify } = fixture()
    mission.maxRepairs = 8
    mission.supervision = { maxRounds: 5, rounds: 0, stalledRounds: 0, decisions: [] }

    // Verification fails identically on every attempt
    verify.mockResolvedValue({ ok: false, output: "FAIL: unchanging broken check" })

    let superviseCalls = 0
    runAgent.mockImplementation(async (_persona, _prompt, _m, stage) => {
      if (stage === "plan") return JSON.stringify({ tasks: plan.tasks, goalBrief: brief })
      if (stage === "work") return "Delivered work"
      if (stage === "review") return passed
      if (stage === "supervise") {
        superviseCalls++
        return JSON.stringify({
          action: "stop",
          reason: "Identical verification failure detected by Chief.",
        })
      }
      return ""
    })

    await expect(coordinate(mission, ports)).rejects.toThrow(
      "Chief Director stopped before achieving the goal: Identical verification failure detected by Chief.",
    )

    // With repeated failure escalation, supervise is triggered on attempt 2 instead of burning 8 repairs!
    expect(superviseCalls).toBe(1)
    expect(verify).toHaveBeenCalledTimes(2)
  })
})
