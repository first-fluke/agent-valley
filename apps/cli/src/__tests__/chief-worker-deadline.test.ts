import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executionPolicySchema } from "@agent-valley/core/chief/execution"
import { mission as missionFixture } from "@agent-valley/core/chief/reports.fixture"
import { MissionStore } from "@agent-valley/core/chief/store"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type OrderSupervisorDependencies, superviseOrder } from "../chief-supervisor"
import { createDeadlineWorkerRunner } from "../chief-worker-deadline"
import { WorkerTerminationError } from "../chief-worker-lifecycle"

vi.mock("@agent-valley/core/config/yaml-loader", () => ({
  loadGlobalConfig: vi.fn(() => null),
  loadProjectConfig: vi.fn(() => null),
}))

let root: string
afterEach(async () => {
  vi.restoreAllMocks()
  if (root) await rm(root, { recursive: true, force: true })
})
type Worker = NonNullable<OrderSupervisorDependencies["runWorker"]>

describe("Mission deadline during worker execution", () => {
  it.each([
    { initial: false, rejectsOnAbort: false },
    { initial: true, rejectsOnAbort: false },
    { initial: false, rejectsOnAbort: true },
  ])(
    "uses the first saved deadline while a worker stalls (initial=$initial, rejection=$rejectsOnAbort)",
    async ({ initial, rejectsOnAbort }) => {
      root = await mkdtemp(join(tmpdir(), "av-worker-deadline-"))
      const store = new MissionStore(join(root, ".agent-valley", "missions"))
      const mission = missionFixture()
      mission.status = "executing"
      mission.executionPolicy = executionPolicySchema.parse({ maxDurationSec: 1 })
      mission.execution = { startedAt: new Date(Date.now() - 500).toISOString(), runsStarted: 4, retries: 1 }
      mission.operations = {
        runs: [
          {
            runId: "unconfirmed-native-run",
            stage: "work",
            actorId: "worker",
            actorType: "codex",
            startedAt: mission.execution.startedAt,
            finishedAt: null,
            elapsedMs: null,
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
            outcome: "pending",
            executionState: "running",
            executionRecovery: "local-process",
          },
        ],
        routingEvidence: [],
        reviewDecisions: [],
      }
      if (!initial) await store.save(mission)
      const controller = new AbortController()
      // Bound the RED case too: the old supervisor only reacts to this later operator cancellation.
      const fallback = setTimeout(() => controller.abort(), 1_500)
      const worker = vi.fn<Worker>().mockImplementation(async (_args, _root, signal) => {
        if (initial) await store.save(mission)
        await new Promise<void>((resolveExit, reject) => {
          const stopped = () => (rejectsOnAbort ? reject(new Error("Worker rejected while stopping")) : resolveExit())
          signal.addEventListener("abort", stopped, { once: true })
          if (signal.aborted) stopped()
        })
        return null
      })
      try {
        const result = await superviseOrder(
          undefined,
          initial ? { missionId: mission.id } : { resume: mission.id },
          root,
          {
            runWorker: worker,
            signal: controller.signal,
          },
        )
        expect(result.status).toBe("paused")
        expect(result.execution).toMatchObject({
          startedAt: mission.execution.startedAt,
          runsStarted: 4,
          retries: 1,
          failureKind: "budget",
        })
        expect(result.executionPolicy).toEqual(mission.executionPolicy)
        expect(result.tasks).toEqual(mission.tasks)
        expect(controller.signal.aborted).toBe(false)
        expect(worker).toHaveBeenCalledOnce()
        expect((await store.load(mission.id)).execution?.failureKind).toBe("budget")
        if (rejectsOnAbort) expect(result.error).toContain("Worker rejected while stopping")
        expect(result.operations?.runs[0]).toMatchObject({
          executionState: "unknown",
          finishedAt: null,
          outcome: "pending",
        })
      } finally {
        clearTimeout(fallback)
      }
    },
  )

  it("does not reset the original deadline for a later worker", async () => {
    root = await mkdtemp(join(tmpdir(), "av-worker-deadline-pin-"))
    const store = new MissionStore(join(root, ".agent-valley", "missions"))
    const mission = missionFixture()
    mission.executionPolicy = executionPolicySchema.parse({ maxDurationSec: 1 })
    mission.execution = { startedAt: new Date(Date.now() - 500).toISOString(), runsStarted: 4, retries: 1 }
    await store.save(mission)
    const parent = new AbortController()
    const run = createDeadlineWorkerRunner(store, mission.id, parent.signal)
    await run(async () => 0, [], root)
    const load = vi.spyOn(store, "load").mockResolvedValue({
      ...mission,
      execution: { ...mission.execution, startedAt: new Date(Date.now() + 60_000).toISOString() },
    })
    const fallback = setTimeout(() => parent.abort(), 1_500)
    try {
      await expect(
        run(
          async (_args, _root, signal) => {
            await new Promise<void>((resolveExit) =>
              signal.addEventListener("abort", () => resolveExit(), { once: true }),
            )
            return null
          },
          [],
          root,
        ),
      ).rejects.toMatchObject({ kind: "budget" })
      expect(load).not.toHaveBeenCalled()
      expect(parent.signal.aborted).toBe(false)
    } finally {
      clearTimeout(fallback)
    }
  })

  it("preserves a live owner's checkpoint and rejects unconfirmed termination without waiting forever", async () => {
    root = await mkdtemp(join(tmpdir(), "av-worker-unconfirmed-"))
    const store = new MissionStore(join(root, ".agent-valley", "missions"))
    const mission = missionFixture()
    mission.status = "executing"
    await store.save(mission)
    const controller = new AbortController()
    let unlock: (() => Promise<void>) | undefined
    const failure = new WorkerTerminationError("Owned worker termination unconfirmed")
    const worker = vi.fn<Worker>().mockImplementation(async () => {
      unlock = await store.lock(mission.id)
      throw failure
    })
    const fallback = setTimeout(() => controller.abort(), 1_500)
    try {
      await expect(
        superviseOrder(undefined, { resume: mission.id }, root, {
          runWorker: worker,
          signal: controller.signal,
        }),
      ).rejects.toBe(failure)
      expect(await store.load(mission.id)).toEqual(mission)
      expect(controller.signal.aborted).toBe(false)
      expect(worker).toHaveBeenCalledOnce()
    } finally {
      clearTimeout(fallback)
      await unlock?.()
    }
  })
})
