import { describe, expect, it, vi } from "vitest"
import {
  type ContinuousBaseline,
  continuousDecisionSchema,
  type Operation,
  operationSchema,
  parseContinuousDecision,
} from "./continuous-contract"
import { type ContinuousOperationPorts, runContinuousOperation } from "./continuous-operation"
import type { Mission } from "./types"

const timestamp = "2026-10-05T00:00:00.000Z"
function operation(overrides: Partial<Operation> = {}): Operation {
  return {
    id: "operation",
    repositoryRoot: "/repo",
    charter: "Keep improving usability and revenue",
    settings: { actor: "codex", model: "pinned-model" },
    phase: "deciding",
    createdAt: timestamp,
    updatedAt: timestamp,
    completedCycles: 0,
    waitIntervalSec: 300,
    history: [],
    ...overrides,
  }
}
function baseline(missionId?: string): ContinuousBaseline {
  return {
    version: 1,
    operationId: "operation",
    repositoryRoot: "/repo",
    sourceWorkspacePath: missionId ? `/child/${missionId}` : "/repo",
    missionId,
    path: `/baseline/${missionId ?? "initial"}`,
    branch: "snapshot",
    baselineHead: "a".repeat(40),
    baselineTree: "b".repeat(40),
    commit: "c".repeat(40),
  }
}
function mission(id: string, goal: string, status: Mission["status"] = "completed"): Mission {
  return {
    id,
    repositoryRoot: "/repo",
    goal,
    chiefId: "chief",
    personas: [],
    workspace: { issueId: id, key: id, path: `/child/${id}`, branch: id, status: "idle", createdAt: timestamp },
    verifyCommand: "true",
    timeoutSec: 5,
    maxRepairs: 0,
    status,
    verification: { ok: true, fingerprint: "verified" },
    finalReview: { passed: true, summary: "Verified", findings: [] },
    tasks: [],
    history: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}
function fixture(record = operation()) {
  let clock = Date.parse(timestamp)
  const saved: Operation[] = []
  const children = new Map<string, Mission>()
  const ports: ContinuousOperationPorts = {
    save: vi.fn(async (value) => {
      saved.push(operationSchema.parse(value))
    }),
    now: () => new Date(clock),
    delay: vi.fn(async (milliseconds) => {
      clock += milliseconds
    }),
    accept: vi.fn(async (_parent, child) => baseline(child?.id)),
    findMission: vi.fn(async (id) => children.get(id)),
    decide: vi.fn(async (value) => ({
      action: "execute" as const,
      goal: `Improve ${value.completedCycles + 1}`,
      reason: "Measured product gap",
      evidence: [`metric-window-${value.completedCycles + 1}`],
    })),
    runMission: vi.fn(async (_parent, id, goal) => {
      const child = mission(id, goal)
      children.set(id, child)
      return child
    }),
  }
  return { record, ports, children, saved }
}

describe("continuous Chief operations", () => {
  it("runs two distinct verified goals from successive accepted baselines with IDs saved before dispatch", async () => {
    const { record, ports, saved } = fixture(operation({ cycleLimit: 2 }))
    const run = ports.runMission
    ports.runMission = vi.fn(async (parent, id, goal, path) => {
      expect(saved.at(-1)).toMatchObject({
        phase: "running",
        currentMissionId: id,
        decision: { action: "execute", goal },
      })
      expect(path).toBe(parent.baseline?.path)
      return run(parent, id, goal, path)
    })
    ports.decide = vi.fn(async (parent, id) => {
      expect(saved.at(-1)?.decisionId).toBe(id)
      return {
        action: "execute" as const,
        goal: `Improve ${parent.completedCycles + 1}`,
        reason: "Measured gap",
        evidence: [String(parent.completedCycles)],
      }
    })
    expect(await runContinuousOperation(record, ports)).toMatchObject({ phase: "completed", completedCycles: 2 })
    expect(ports.runMission).toHaveBeenCalledTimes(2)
    const calls = vi.mocked(ports.runMission).mock.calls
    expect(calls[0]?.[3]).toBe("/baseline/initial")
    expect(calls[1]?.[3]).toBe(`/baseline/${calls[0]?.[1]}`)
    expect(record.history.map((entry) => entry.goal)).toEqual(["Improve 1", "Improve 2"])
    expect(record.settings.model).toBe("pinned-model")
  })

  it("persists a wait and honors its full timestamp even when delay returns after only thirty seconds", async () => {
    const { record, ports, saved } = fixture(operation({ cycleLimit: 1 }))
    let count = 0
    ports.decide = vi.fn(async () =>
      ++count === 1
        ? { action: "wait" as const, reason: "Real analytics data unavailable" }
        : {
            action: "execute" as const,
            goal: "Repair metrics collection",
            reason: "Source still unavailable",
            evidence: ["analytics:error"],
          },
    )
    await runContinuousOperation(record, ports)
    expect(ports.delay).toHaveBeenCalledTimes(10)
    expect(saved.some((item) => item.phase === "waiting" && item.nextRunAt === "2026-10-05T00:05:00.000Z")).toBe(true)
    expect(record.phase).toBe("completed")
  })

  it("waits on identical consecutive goal and evidence, then accepts a fresh evidence window", async () => {
    const { record, ports } = fixture(operation({ cycleLimit: 2 }))
    let round = 0
    ports.decide = vi.fn(async () => ({
      action: "execute" as const,
      goal: "Improve conversion",
      reason: "Observed conversion",
      evidence: [++round <= 2 ? "window-1" : "window-2"],
    }))
    await runContinuousOperation(record, ports)
    expect(ports.decide).toHaveBeenCalledTimes(3)
    expect(ports.runMission).toHaveBeenCalledTimes(2)
    expect(ports.delay).toHaveBeenCalledTimes(10)
  })

  it("recovers a completed child after snapshot failure without rerunning it or recounting it", async () => {
    const { record, ports, children } = fixture(operation({ cycleLimit: 1 }))
    const accept = ports.accept
    let fail = true
    ports.accept = vi.fn(async (parent, child) => {
      if (child && fail) {
        fail = false
        throw new Error("Snapshot interrupted")
      }
      return accept(parent, child)
    })
    await runContinuousOperation(record, ports)
    expect(record).toMatchObject({ phase: "paused", completedCycles: 0, error: "Snapshot interrupted" })
    expect(children.get(record.currentMissionId ?? "")?.status).toBe("completed")
    await runContinuousOperation(record, ports)
    expect(record).toMatchObject({ phase: "completed", completedCycles: 1 })
    expect(ports.runMission).toHaveBeenCalledTimes(1)
  })

  it.each(["paused", "failed"] as const)(
    "retains a %s child and never silently retries its effects",
    async (status) => {
      const decision = { action: "execute" as const, goal: "Publish product", reason: "ROI goal", evidence: ["window"] }
      const { record, ports, children } = fixture(
        operation({ baseline: baseline(), phase: "paused", currentMissionId: "child", decision, cycleLimit: 1 }),
      )
      children.set("child", { ...mission("child", decision.goal, status), error: "External effect is unknown" })
      await runContinuousOperation(record, ports)
      await runContinuousOperation(record, ports)
      expect(ports.runMission).not.toHaveBeenCalled()
      expect(record).toMatchObject({ phase: "paused", currentMissionId: "child", completedCycles: 0 })
      expect(record.error).toContain("External effect is unknown")
      children.set("child", mission("child", decision.goal))
      await runContinuousOperation(record, ports)
      expect(record.phase).toBe("completed")
    },
  )

  it("pauses on malformed decisions with a durable checkpoint and no automatic paid retry", async () => {
    const { record, ports } = fixture()
    ports.decide = vi.fn(async () => ({
      action: "execute" as const,
      goal: "x",
      reason: "x",
      evidence: ["repository"],
      extra: "unsupported",
    }))
    await runContinuousOperation(record, ports)
    expect(record.phase).toBe("paused")
    expect(record.decisionId).toBeDefined()
    expect(ports.decide).toHaveBeenCalledTimes(1)
    expect(ports.runMission).not.toHaveBeenCalled()
  })

  it("has no default cycle ceiling and abort retains the next checkpoint and completed count", async () => {
    const { record, ports } = fixture()
    const controller = new AbortController()
    ports.signal = controller.signal
    const save = ports.save
    ports.save = async (value) => {
      await save(value)
      if (value.completedCycles === 2) controller.abort()
    }
    await runContinuousOperation(record, ports)
    expect(record).toMatchObject({ phase: "paused", completedCycles: 2 })
    expect(ports.runMission).toHaveBeenCalledTimes(2)
  })

  it("counts an optional limit cumulatively across restarts", async () => {
    const { record, ports } = fixture(
      operation({ baseline: baseline("prior"), completedCycles: 5, cycleLimit: 5, phase: "paused" }),
    )
    await runContinuousOperation(record, ports)
    expect(record.phase).toBe("completed")
    expect(ports.decide).not.toHaveBeenCalled()
  })

  it("rejects a foreign child and keeps its original identity for inspection", async () => {
    const decision = { action: "execute" as const, goal: "Improve", reason: "Metric", evidence: ["repository"] }
    const { record, ports, children } = fixture(
      operation({ baseline: baseline(), phase: "running", currentMissionId: "child", decision }),
    )
    children.set("child", { ...mission("child", decision.goal), repositoryRoot: "/other" })
    await runContinuousOperation(record, ports)
    expect(record.phase).toBe("paused")
    expect(record.currentMissionId).toBe("child")
    expect(ports.accept).not.toHaveBeenCalled()
    expect(ports.runMission).not.toHaveBeenCalled()
  })

  it("retains the accepting phase through pause and never relaunches a missing completed child", async () => {
    const decision = { action: "execute" as const, goal: "Improve", reason: "Metric", evidence: ["repository"] }
    const { record, ports } = fixture(
      operation({
        baseline: baseline(),
        phase: "paused",
        resumePhase: "accepting",
        currentMissionId: "missing-completed",
        decision,
      }),
    )
    await runContinuousOperation(record, ports)
    expect(record).toMatchObject({ phase: "paused", resumePhase: "accepting", currentMissionId: "missing-completed" })
    expect(ports.runMission).not.toHaveBeenCalled()
    expect(record.error).toContain("missing")
  })

  it("checks pending child identity before any recovery execution", async () => {
    const decision = { action: "execute" as const, goal: "Improve", reason: "Metric", evidence: ["repository"] }
    const { record, ports, children } = fixture(
      operation({ baseline: baseline(), phase: "running", currentMissionId: "child", decision }),
    )
    children.set("child", { ...mission("child", decision.goal, "pending"), repositoryRoot: "/foreign" })
    await runContinuousOperation(record, ports)
    expect(record.phase).toBe("paused")
    expect(ports.runMission).not.toHaveBeenCalled()
  })

  it("does not resume a pending child whose effect state is unknown", async () => {
    const decision = { action: "execute" as const, goal: "Improve", reason: "Metric", evidence: ["repository"] }
    const { record, ports, children } = fixture(
      operation({ baseline: baseline(), phase: "running", currentMissionId: "child", decision }),
    )
    children.set("child", {
      ...mission("child", decision.goal, "pending"),
      tasks: [{ id: "effect", reviewerId: "reviewer", status: "pending", attempts: 1, effectState: "unknown" }],
    })
    await runContinuousOperation(record, ports)
    expect(record.error).toContain("unknown effect")
    expect(ports.runMission).not.toHaveBeenCalled()
  })

  it("rejects a completed checkpoint without passing verification and final review", async () => {
    const decision = { action: "execute" as const, goal: "Improve", reason: "Metric", evidence: ["repository"] }
    const { record, ports, children } = fixture(
      operation({ baseline: baseline(), phase: "running", currentMissionId: "child", decision }),
    )
    children.set("child", { ...mission("child", decision.goal), verification: { ok: false, fingerprint: "failed" } })
    await runContinuousOperation(record, ports)
    expect(record.phase).toBe("paused")
    expect(ports.accept).not.toHaveBeenCalled()
  })

  it("bounds prompt history while preserving the cumulative count", async () => {
    const { record, ports } = fixture(operation({ cycleLimit: 25 }))
    await runContinuousOperation(record, ports)
    expect(record.history).toHaveLength(20)
    expect(record.completedCycles).toBe(25)
    expect(record.history[0]?.goal).toBe("Improve 6")
  })
})

describe("continuous operation boundaries", () => {
  it("accepts strict JSON decisions and rejects unknown fields, empty goals and invalid evidence", () => {
    expect(parseContinuousDecision('{"action":"wait","reason":"Waiting for source"}')).toEqual({
      action: "wait",
      reason: "Waiting for source",
    })
    expect(() => parseContinuousDecision('{"action":"wait","reason":"x","run":"rm"}')).toThrow()
    expect(() => parseContinuousDecision("sensitive-invalid-json")).toThrow("Invalid Chief decision")
    expect(() => parseContinuousDecision("x".repeat(256_001))).toThrow("Invalid Chief decision")
    expect(
      continuousDecisionSchema.safeParse({ action: "execute", goal: "x", reason: "x", evidence: [] }).success,
    ).toBe(false)
    expect(
      continuousDecisionSchema.safeParse({ action: "execute", goal: " ", reason: "x", evidence: [] }).success,
    ).toBe(false)
    expect(
      continuousDecisionSchema.safeParse({ action: "execute", goal: "x", reason: "x", evidence: [""] }).success,
    ).toBe(false)
  })
  it("requires phase checkpoints and rejects foreign baselines and unsafe IDs", () => {
    expect(operationSchema.safeParse(operation({ phase: "running" })).success).toBe(false)
    expect(operationSchema.safeParse(operation({ phase: "waiting" })).success).toBe(false)
    expect(operationSchema.safeParse(operation({ baseline: { ...baseline(), operationId: "other" } })).success).toBe(
      false,
    )
    expect(operationSchema.safeParse(operation({ id: "../outside" })).success).toBe(false)
  })
})
