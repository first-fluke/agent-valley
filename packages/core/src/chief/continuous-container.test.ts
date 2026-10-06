import { describe, expect, it, vi } from "vitest"
import { type ContainerObservationSnapshot, containerObservationPolicySchema } from "./container-observation-policy"
import { type Operation, operationSchema } from "./continuous-contract"
import { type ContinuousOperationPorts, runContinuousOperation } from "./continuous-operation"
import { mission as completedMission } from "./continuous-operation.fixture"
import type { Mission } from "./types"

const start = Date.parse("2026-10-06T00:00:00.000Z")
const policy = containerObservationPolicySchema.parse({
  targets: [{ id: "api", kind: "docker", container: "api" }],
  poll_interval_sec: 10,
})
function snapshot(clock: number, fingerprint = "a", unhealthy = false): ContainerObservationSnapshot {
  return {
    collectedAt: new Date(clock).toISOString(),
    nextPollAt: new Date(clock + 10_000).toISOString(),
    fingerprint: fingerprint.repeat(64),
    results: [
      {
        targetId: "api",
        kind: "docker",
        status: "collected",
        identity: "container-1",
        state: "running",
        ready: true,
        restartCount: 7,
        logsAvailable: true,
        statsAvailable: true,
        issues: unhealthy ? ["unhealthy"] : [],
        fingerprint: fingerprint.repeat(64),
      },
    ],
  }
}
function fixture() {
  let clock = start
  const operation: Operation = operationSchema.parse({
    id: "operation",
    repositoryRoot: "/repo",
    charter: "Keep API service healthy",
    settings: { workspace: "/repo", actor: "codex", model: "pinned", runs: "2" },
    phase: "deciding",
    createdAt: new Date(clock).toISOString(),
    updatedAt: new Date(clock).toISOString(),
    completedCycles: 0,
    waitIntervalSec: 300,
    containerObservationPolicy: policy,
    history: [],
  })
  const controller = new AbortController()
  const children = new Map<string, Mission>()
  const ports: ContinuousOperationPorts = {
    signal: controller.signal,
    now: () => new Date(clock),
    save: vi.fn(async (value) => {
      operationSchema.parse(value)
    }),
    delay: vi.fn(async (duration) => {
      clock += duration
    }),
    observeContainers: vi.fn(async () => snapshot(clock)),
    decide: vi.fn<ContinuousOperationPorts["decide"]>(async () => ({ action: "wait", reason: "No new incident" })),
    findMission: async (id) => children.get(id),
    runMission: vi.fn(async (current, id, goal) => {
      const observed = snapshot(clock)
      const mission: Mission = {
        ...completedMission(id, goal),
        id,
        goal,
        repositoryRoot: "/repo",
        chiefId: "chief",
        workspace: {
          issueId: id,
          key: id,
          path: "/child",
          branch: id,
          status: "idle",
          createdAt: new Date(clock).toISOString(),
        },
        verifyCommand: "true",
        timeoutSec: 5,
        maxRepairs: 0,
        status: "completed",
        verification: { ok: true, fingerprint: "verified" },
        history: [],
        createdAt: new Date(clock).toISOString(),
        updatedAt: new Date(clock).toISOString(),
        containerObservationPolicy: current.containerObservationPolicy,
        containerObservation: observed,
        containerObservationVerifiedFingerprint: observed.fingerprint,
      }
      children.set(id, mission)
      return mission
    }),
    accept: vi.fn<ContinuousOperationPorts["accept"]>(async (_current, child) => ({
      version: 1,
      operationId: "operation",
      repositoryRoot: "/repo",
      sourceWorkspacePath: child?.workspace.path ?? "/repo",
      missionId: child?.id,
      path: `/baseline/${child?.id ?? "initial"}`,
      branch: "snapshot",
      baselineHead: "a".repeat(40),
      baselineTree: "b".repeat(40),
      commit: "c".repeat(40),
    })),
  }
  return { operation, ports, controller, children, clock: () => clock }
}

describe("continuous container observations", () => {
  it("polls unchanged historical evidence without repeating Chief calls, retaining the last observation across resume", async () => {
    const { operation, ports, controller, clock } = fixture()
    const delay = ports.delay
    ports.delay = async (duration, signal) => {
      await delay(duration, signal)
      if (clock() >= start + 30_000) controller.abort()
    }
    await runContinuousOperation(operation, ports)
    expect(ports.decide).toHaveBeenCalledOnce()
    expect(ports.observeContainers).toHaveBeenCalledTimes(3)
    expect(operation).toMatchObject({
      phase: "paused",
      resumePhase: "waiting",
      containerObservation: { fingerprint: "a".repeat(64) },
    })
    const resumed = new AbortController()
    ports.signal = resumed.signal
    ports.delay = async () => {
      resumed.abort()
    }
    await runContinuousOperation(operation, ports)
    expect(ports.decide).toHaveBeenCalledOnce()
    expect(operation.settings).toEqual({ workspace: "/repo", actor: "codex", model: "pinned", runs: "2" })
  })

  it("wakes once on changed health evidence before the normal decision interval", async () => {
    const { operation, ports, controller, clock } = fixture()
    ports.observeContainers = vi.fn(async () =>
      snapshot(clock(), clock() >= start + 10_000 ? "b" : "a", clock() >= start + 10_000),
    )
    ports.decide = vi.fn<ContinuousOperationPorts["decide"]>(async () => {
      if (clock() >= start + 10_000) controller.abort()
      return { action: "wait", reason: "Incident requires more evidence" }
    })
    await runContinuousOperation(operation, ports)
    expect(ports.decide).toHaveBeenCalledTimes(2)
    expect(clock()).toBe(start + 10_000)
    expect(operation.decisionObservation?.fingerprint).toBe("b".repeat(64))
  })

  it("pins observation evidence before a decision and reuses it after an interrupted paid call", async () => {
    const { operation, ports, clock } = fixture()
    ports.decide = vi.fn(async (current) => {
      expect(current.decisionObservation?.fingerprint).toBe("a".repeat(64))
      throw new Error("Saved decision budget exhausted")
    })
    await runContinuousOperation(operation, ports)
    const id = operation.decisionId
    ports.observeContainers = vi.fn(async () => snapshot(clock(), "b", true))
    await runContinuousOperation(operation, ports)
    expect(operation.decisionId).toBe(id)
    expect(ports.observeContainers).not.toHaveBeenCalled()
    expect(operation.decisionObservation?.fingerprint).toBe("a".repeat(64))
  })

  it("allows the same goal with genuinely changed incident evidence", async () => {
    const { operation, ports, clock } = fixture()
    operation.cycleLimit = 2
    ports.decide = vi.fn<ContinuousOperationPorts["decide"]>(async () => ({
      action: "execute",
      goal: "Repair API service",
      reason: "Observed incident",
      evidence: ["api"],
    }))
    ports.observeContainers = vi.fn(async () => snapshot(clock(), operation.completedCycles === 0 ? "a" : "b"))
    await runContinuousOperation(operation, ports)
    expect(operation).toMatchObject({ phase: "completed", completedCycles: 2 })
    expect(ports.runMission).toHaveBeenCalledTimes(2)
    expect(ports.delay).not.toHaveBeenCalled()
  })

  it("executes a recurring identical failure after recovery as a new transition", async () => {
    const { operation, ports, clock } = fixture()
    operation.cycleLimit = 2
    ports.observeContainers = vi.fn(async () => {
      const failed =
        (operation.completedCycles === 0 && !operation.currentMissionId) ||
        (clock() >= start + 10_000 && !operation.currentMissionId)
      return snapshot(clock(), failed ? "b" : "a", failed)
    })
    ports.decide = vi.fn<ContinuousOperationPorts["decide"]>(async (current) =>
      current.decisionObservation?.results[0]?.issues.length
        ? { action: "execute", goal: "Repair API", reason: "Observed API log error", evidence: ["api:same-error"] }
        : { action: "wait", reason: "Service recovered; observe the next incident" },
    )
    await runContinuousOperation(operation, ports)
    expect(operation).toMatchObject({ phase: "completed", completedCycles: 2, containerObservationRevision: 4 })
    expect(ports.runMission).toHaveBeenCalledTimes(2)
    expect(ports.decide).toHaveBeenCalledTimes(3)
    expect(clock()).toBe(start + 10_000)
    expect(operation.history[0]?.goal).toBe(operation.history[1]?.goal)
    expect(operation.history[0]?.evidence).toEqual(operation.history[1]?.evidence)
  })

  it("does not accept a completed child whose service has failed after its saved healthy observation", async () => {
    const { operation, ports, clock } = fixture()
    operation.cycleLimit = 1
    ports.decide = vi.fn<ContinuousOperationPorts["decide"]>(async () => ({
      action: "execute",
      goal: "Repair API",
      reason: "Incident",
      evidence: ["api"],
    }))
    let calls = 0
    ports.observeContainers = vi.fn(async () => snapshot(clock(), ++calls === 1 ? "a" : "b", calls > 1))
    await runContinuousOperation(operation, ports)
    expect(operation).toMatchObject({ phase: "paused", completedCycles: 0 })
    expect(operation.error).toContain("passed code checks")
    expect(operation.currentMissionId).toBeDefined()
    expect(ports.accept).toHaveBeenCalledOnce()
    await runContinuousOperation(operation, ports)
    expect(ports.runMission).toHaveBeenCalledOnce()
    expect(operation.completedCycles).toBe(0)
  })

  it.each(["stale", "foreign", "missing"])("fails closed on %s source evidence without a Chief call", async (kind) => {
    const { operation, ports, clock } = fixture()
    ports.observeContainers = vi.fn(async () => {
      const observed = snapshot(kind === "stale" ? start - 60_000 : clock())
      if (kind === "foreign" && observed.results[0]) observed.results[0].targetId = "other"
      if (kind === "missing") observed.results = []
      return observed
    })
    await runContinuousOperation(operation, ports)
    expect(operation.phase).toBe("paused")
    expect(ports.decide).not.toHaveBeenCalled()
  })
})
