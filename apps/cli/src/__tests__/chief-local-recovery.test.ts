import { randomUUID } from "node:crypto"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executionPolicySchema } from "@agent-valley/core/chief/execution"
import { mission as missionFixture } from "@agent-valley/core/chief/reports.fixture"
import { MissionStore } from "@agent-valley/core/chief/store"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { reobserveLocalExecutions } from "../chief-local-recovery"
import { superviseOrder } from "../chief-supervisor"

vi.mock("@agent-valley/core/config/yaml-loader", () => ({
  loadGlobalConfig: vi.fn(() => null),
  loadProjectConfig: vi.fn(() => null),
}))

let root: string
let store: MissionStore
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "av-local-reobserve-"))
  store = new MissionStore(join(root, ".agent-valley", "missions"))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

function checkpoint() {
  const mission = missionFixture()
  if (mission.supervision) mission.supervision.operatorGoal = mission.goal
  mission.status = "paused"
  mission.executionPolicy = executionPolicySchema.parse({ maxRuns: 20 })
  mission.execution = {
    startedAt: new Date().toISOString(),
    runsStarted: 4,
    retries: 1,
    failureKind: "unknown-effect",
  }
  mission.operations = {
    runs: [
      {
        runId: "uncertain-local",
        stage: "work",
        actorId: "worker",
        actorType: "claude",
        startedAt: mission.execution.startedAt,
        finishedAt: null,
        elapsedMs: null,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        outcome: "pending",
        executionState: "unknown",
        executionRecovery: "local-process",
      },
    ],
    routingEvidence: [],
    reviewDecisions: [],
  }
  return mission
}

async function marker(missionId: string, pid = 654321) {
  const path = join(root, ".agent-valley", "missions", `${missionId}.run-uncertain-local.active`)
  await writeFile(
    path,
    JSON.stringify({ version: 1, token: randomUUID(), stage: "work", pid, group: false, ownerPid: process.pid }),
  )
  return path
}

describe("automatic local execution re-observation", () => {
  it("reads a live owner's latest checkpoint without reconciling its unknown execution", async () => {
    const mission = checkpoint()
    await store.save(mission)
    const path = join(root, ".agent-valley", "missions", `${mission.id}.json`)
    const original = await readFile(path, "utf8")
    const unlock = await store.lock(mission.id)
    const recover = vi.spyOn(store, "recoverProcesses")
    try {
      expect(await reobserveLocalExecutions(mission, store)).toEqual(await store.load(mission.id))
      expect(recover).not.toHaveBeenCalled()
      expect(await readFile(path, "utf8")).toBe(original)
    } finally {
      await unlock()
    }
  })

  it("joins a confirmed ownership race by reloading without changing the competing checkpoint", async () => {
    const mission = checkpoint()
    await store.save(mission)
    const acquire = store.lock.bind(store)
    let release: (() => Promise<void>) | undefined
    vi.spyOn(store, "lock").mockImplementationOnce(async (id) => {
      release = await acquire(id)
      const latest = await store.load(id)
      latest.status = "planning"
      await store.save(latest)
      throw new Error(`Mission ${id} is already running (PID ${process.pid}). Stop that run before resuming.`)
    })
    const recover = vi.spyOn(store, "recoverProcesses")
    try {
      const observed = await reobserveLocalExecutions(mission, store)
      expect(observed.status).toBe("planning")
      expect(observed.execution).toEqual(mission.execution)
      expect(recover).not.toHaveBeenCalled()
      expect((await store.load(mission.id)).operations?.runs[0]?.executionState).toBe("unknown")
    } finally {
      await release?.()
    }
  })

  it("propagates storage permission errors rather than treating them as a live owner", async () => {
    const mission = checkpoint()
    await store.save(mission)
    const error = Object.assign(new Error("Cannot write mission storage"), { code: "EACCES" })
    vi.spyOn(store, "lock").mockRejectedValueOnce(error)

    await expect(reobserveLocalExecutions(mission, store)).rejects.toBe(error)
  })

  it("uses stopped-process proof before resuming the same Chief recovery without resetting spend", async () => {
    const mission = checkpoint()
    await store.save(mission)
    const path = await marker(mission.id)
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      expect(signal).toBe(0)
      throw Object.assign(new Error("absent"), { code: "ESRCH" })
    })
    const worker = vi
      .fn()
      .mockResolvedValueOnce(2)
      .mockImplementationOnce(async () => {
        const latest = await store.load(mission.id)
        expect(latest.operations?.runs[0]).toMatchObject({
          executionState: "settled",
          outcome: "failed",
          costUsd: null,
        })
        expect(latest.execution).toMatchObject({ startedAt: mission.execution?.startedAt, runsStarted: 4, retries: 1 })
        expect(latest.supervision?.pendingRecovery).toBeDefined()
        expect(latest.tasks).toEqual(mission.tasks)
        latest.status = "completed"
        await store.save(latest)
        return 0
      })
    const result = await superviseOrder(undefined, { resume: mission.id }, root, {
      runWorker: worker,
      delay: vi.fn().mockResolvedValue(undefined),
    })
    expect(result.status).toBe("completed")
    expect(worker).toHaveBeenCalledTimes(2)
    expect(worker.mock.calls[1]?.[0]).toEqual(["order", "--once", "--worker", "--resume", mission.id])
    expect(kill).toHaveBeenCalled()
    await expect(access(path)).rejects.toThrow()
  })

  it.each(["missing-marker", "remote", "external-effect", "operator-stopped", "live"] as const)(
    "protects %s rather than replaying an uncertain action",
    async (kind) => {
      const mission = checkpoint()
      const run = mission.operations?.runs[0]
      const task = mission.tasks[0]
      if (!run || !task || !mission.execution) throw new Error("Expected saved execution and task")
      if (kind === "remote") run.executionRecovery = "reconcile"
      if (kind === "external-effect") task.effectState = "unknown"
      if (kind === "operator-stopped") mission.execution.failureKind = "interrupted"
      await store.save(mission)
      if (kind !== "missing-marker") await marker(mission.id, kind === "live" ? process.pid : 654321)
      const worker = vi.fn().mockResolvedValue(2)
      const result = await superviseOrder(undefined, { resume: mission.id }, root, { runWorker: worker })
      expect(worker).toHaveBeenCalledOnce()
      expect(result.status).toBe("paused")
      expect(result.execution?.runsStarted).toBe(4)
      expect(result.execution?.startedAt).toBe(mission.execution?.startedAt)
      if (kind !== "external-effect") expect(result.operations?.runs[0]?.executionState).toBe("unknown")
      if (kind === "external-effect") expect(result.tasks[0]?.effectState).toBe("unknown")
    },
  )
})
