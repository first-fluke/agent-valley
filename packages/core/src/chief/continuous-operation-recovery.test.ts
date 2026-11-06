import { describe, expect, it, vi } from "vitest"
import { runContinuousOperation } from "./continuous-operation"
import { baseline, fixture, mission, operation, timestamp } from "./continuous-operation.fixture"
import { executionPolicySchema } from "./execution"

function scheduledChild(delaySec = 1) {
  const decision = {
    action: "execute" as const,
    goal: "Repair service",
    reason: "Observed failure",
    evidence: ["service"],
  }
  const result = fixture(
    operation({ baseline: baseline(), phase: "running", currentMissionId: "child", decision, cycleLimit: 1 }),
  )
  const child = mission("child", decision.goal, "waiting")
  child.executionPolicy = executionPolicySchema.parse({ maxRuns: 10 })
  child.execution = {
    startedAt: timestamp,
    runsStarted: 1,
    retries: 1,
    failureKind: "chief-wait",
    nextRunAt: new Date(Date.parse(timestamp) + delaySec * 1000).toISOString(),
  }
  child.supervision = {
    maxRounds: 10,
    rounds: 1,
    stalledRounds: 0,
    originalAcceptance: ["Verified improvement"],
    decisions: [
      {
        round: 1,
        at: timestamp,
        action: "wait",
        reason: "Collect fresh service evidence",
        fingerprint: "service",
        retryAfterSec: delaySec,
      },
    ],
  }
  result.children.set(child.id, child)
  return { ...result, child }
}

describe("durable child recovery continuations", () => {
  it("honors successive saved Chief waits without consuming failed recovery allowance or replacing the child", async () => {
    const { record, ports, child, saved } = scheduledChild()
    let resumed = 0
    ports.runMission = vi.fn(async (_parent, id, goal) => {
      expect([id, goal]).toEqual([child.id, child.goal])
      expect(saved.at(-1)?.recovery).toMatchObject({ attempts: resumed + 1, failedAttempts: 0 })
      resumed += 1
      if (!child.execution || !child.supervision) throw new Error("Expected Chief checkpoint")
      child.execution.runsStarted += 1
      if (resumed === 5) child.status = "completed"
      else {
        const at = ports.now?.()?.toISOString() ?? timestamp
        child.supervision.rounds += 1
        child.supervision.decisions.push({
          round: child.supervision.rounds,
          at,
          action: "wait",
          reason: "Collect fresh evidence",
          fingerprint: "service",
          retryAfterSec: 1,
        })
        child.execution.nextRunAt = new Date(Date.parse(at) + 1000).toISOString()
      }
      return child
    })
    await runContinuousOperation(record, ports)
    expect(record).toMatchObject({ phase: "completed", completedCycles: 1 })
    expect(ports.runMission).toHaveBeenCalledTimes(5)
    expect(ports.decide).not.toHaveBeenCalled()
    expect(child.execution).toMatchObject({ runsStarted: 6, retries: 1, startedAt: timestamp })
  })

  it("bounds a stale wait that never records another Chief decision across resumes", async () => {
    const { record, ports, child } = scheduledChild()
    ports.runMission = vi.fn(async () => child)
    await runContinuousOperation(record, ports)
    await runContinuousOperation(record, ports)
    expect(ports.runMission).toHaveBeenCalledTimes(4)
    expect(record.recovery).toMatchObject({ attempts: 4, failedAttempts: 3, disposition: "unresolved" })
    expect(record.currentMissionId).toBe("child")
  })

  it("stops at the original deadline during a longer Chief wait without dispatching another child call", async () => {
    const { record, ports, child } = scheduledChild(60)
    if (!child.executionPolicy) throw new Error("Expected policy")
    child.executionPolicy.maxDurationSec = 2
    ports.runMission = vi.fn(async () => child)
    await runContinuousOperation(record, ports)
    expect(ports.runMission).not.toHaveBeenCalled()
    expect(record.phase).toBe("paused")
    expect(record.recovery).toMatchObject({ attempts: 0, failedAttempts: 0, disposition: "protected" })
    expect(record.error).toContain("time limit reached")
    expect(child.execution).toMatchObject({ runsStarted: 1, retries: 1, startedAt: timestamp })
  })
})

describe("explicitly resumed child recovery reporting", () => {
  function resumedChild(status: "planning" | "executing" | "paused" | "failed" = "planning") {
    const decision = {
      action: "execute" as const,
      goal: "Finish the saved task",
      reason: "Original evidence",
      evidence: ["saved checkpoint"],
    }
    const result = fixture(
      operation({
        baseline: baseline(),
        phase: "paused",
        resumePhase: "running",
        pauseKind: "blocked",
        currentMissionId: "child",
        decision,
        cycleLimit: 1,
        recovery: {
          target: "child",
          checkpointId: "child",
          attempts: 3,
          failedAttempts: 3,
          disposition: "protected",
          reason: "The operation was cancelled; automatic recovery is stopped.",
        },
      }),
    )
    const child = mission("child", decision.goal, status)
    child.executionPolicy = executionPolicySchema.parse({ maxRuns: 10 })
    child.execution = { startedAt: timestamp, runsStarted: 4, retries: 1, interventionAt: timestamp }
    result.children.set(child.id, child)
    return { ...result, child }
  }

  it.each(["planning", "executing"] as const)(
    "updates protected cancellation wording before joining a resumed %s child without replenishing attempts",
    async (status) => {
      const { record, ports, child, saved } = resumedChild(status)
      const execution = structuredClone(child.execution)
      const policy = structuredClone(child.executionPolicy)
      ports.runMission = vi.fn(async (_parent, id, goal) => {
        expect([id, goal]).toEqual([child.id, child.goal])
        expect(saved.at(-1)?.recovery).toMatchObject({ attempts: 3, failedAttempts: 3, disposition: "retrying" })
        expect(saved.at(-1)?.recovery?.reason).toContain(`resumed ${status}`)
        child.status = "completed"
        return child
      })

      await runContinuousOperation(record, ports)

      expect(ports.runMission).toHaveBeenCalledOnce()
      expect(ports.decide).not.toHaveBeenCalled()
      expect(child.execution).toEqual(execution)
      expect(child.executionPolicy).toEqual(policy)
      expect(record).toMatchObject({ phase: "completed", completedCycles: 1 })
    },
  )

  it.each(["paused", "running", "accepting"] as const)(
    "updates stale cancellation wording before observing an owned child from %s without lifting protection",
    async (phase) => {
      const { record, ports, child, saved } = resumedChild()
      record.phase = phase
      if (phase !== "paused") {
        record.resumePhase = undefined
        record.pauseKind = undefined
      }
      let release!: (value: typeof child) => void
      ports.findMission = vi.fn(
        () =>
          new Promise<typeof child>((resolve) => {
            release = resolve
          }),
      )
      ports.runMission = vi.fn(async () => {
        child.status = "completed"
        return child
      })
      const running = runContinuousOperation(record, ports)
      await vi.waitFor(() => expect(ports.findMission).toHaveBeenCalledOnce())

      expect(saved.at(-1)?.recovery).toMatchObject({ attempts: 3, failedAttempts: 3, disposition: "protected" })
      expect(saved.at(-1)?.phase).toBe(phase === "paused" ? "running" : phase)
      expect(saved.at(-1)?.recovery?.reason).toContain("observing the original child checkpoint")
      expect(ports.runMission).not.toHaveBeenCalled()
      release(child)
      await running
    },
  )

  it.each(["paused", "failed"] as const)(
    "keeps a still-interrupted %s child protected instead of forcing a retry",
    async (status) => {
      const { record, ports, child } = resumedChild(status)
      if (!child.execution) throw new Error("Expected execution")
      child.execution.failureKind = "interrupted"

      await runContinuousOperation(record, ports)

      expect(ports.runMission).not.toHaveBeenCalled()
      expect(record.recovery).toMatchObject({
        attempts: 3,
        failedAttempts: 3,
        disposition: "protected",
        reason: "The operation was cancelled; automatic recovery is stopped.",
      })
      expect(record.phase).toBe("paused")
    },
  )

  it("retains protection for an unknown external effect after explicit parent resume", async () => {
    const { record, ports, child } = resumedChild("executing")
    const task = child.tasks[0]
    if (!task) throw new Error("Expected task")
    task.effectState = "unknown"

    await runContinuousOperation(record, ports)

    expect(ports.runMission).not.toHaveBeenCalled()
    expect(record.recovery).toMatchObject({ attempts: 3, failedAttempts: 3, disposition: "protected" })
    expect(record.recovery?.reason).toContain("unknown external effect")
    expect(task.effectState).toBe("unknown")
    expect(record.currentMissionId).toBe(child.id)
  })

  it("keeps a new Chief stop protected even though its earlier operator cancellation was cleared", async () => {
    const { record, ports, child } = resumedChild("failed")
    child.supervision = {
      maxRounds: 8,
      rounds: 1,
      stalledRounds: 0,
      decisions: [
        { round: 1, at: timestamp, action: "stop", reason: "No eligible routing candidate", fingerprint: "unchanged" },
      ],
    }

    await runContinuousOperation(record, ports)

    expect(ports.runMission).not.toHaveBeenCalled()
    expect(record.recovery).toMatchObject({ attempts: 3, failedAttempts: 3, disposition: "protected" })
    expect(record.recovery?.reason).toContain("Chief stopped recovery")
    expect(record.recovery?.reason).not.toContain("cancelled")
    expect(record.phase).toBe("paused")
  })
})
