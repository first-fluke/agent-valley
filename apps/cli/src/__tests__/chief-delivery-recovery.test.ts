import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executionPolicySchema } from "@agent-valley/core/chief/execution"
import { mission as missionFixture } from "@agent-valley/core/chief/reports.fixture"
import { MissionStore } from "@agent-valley/core/chief/store"
import { afterEach, describe, expect, it, vi } from "vitest"
import { orderExitCode } from "../chief-outcome"
import { superviseOrder } from "../chief-supervisor"
import { watchOrders } from "../chief-watch"

let root: string | undefined
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (root) await rm(root, { recursive: true, force: true })
})

describe("completed work with pending delivery", () => {
  it("resumes only the delivery checkpoint without changing work or spent allowances", async () => {
    vi.useFakeTimers()
    const now = Date.now()
    root = await mkdtemp(join(tmpdir(), "av-delivery-recovery-"))
    const store = new MissionStore(join(root, ".agent-valley", "missions"))
    const mission = missionFixture()
    if (mission.supervision) mission.supervision.operatorGoal = mission.goal
    mission.executionPolicy = executionPolicySchema.parse({})
    mission.execution = { startedAt: new Date(now - 10_000).toISOString(), runsStarted: 8, retries: 2 }
    mission.codeDelivery = {
      policy: {
        branch: "main",
        remote: "origin",
        paths: ["allowed.ts"],
        message: "fix: deliver",
        baseSha: "a".repeat(40),
      },
      phase: "pending",
      attempts: 1,
      updatedAt: new Date(now).toISOString(),
      nextRunAt: new Date(now + 1_000).toISOString(),
    }
    await store.save(mission)
    expect(orderExitCode(mission)).toBe(2)
    const worker = vi
      .fn()
      .mockResolvedValueOnce(2)
      .mockImplementationOnce(async () => {
        const saved = await store.load(mission.id)
        expect(saved.tasks).toEqual(mission.tasks)
        expect(saved.execution).toEqual(mission.execution)
        if (!saved.codeDelivery) throw new Error("Expected original delivery")
        saved.codeDelivery.phase = "unchanged"
        await store.save(saved)
        return 0
      })
    const result = await superviseOrder(undefined, { resume: mission.id }, root, {
      runWorker: worker,
      delay: async (milliseconds) => {
        vi.setSystemTime(Date.now() + milliseconds)
      },
    })
    expect(worker).toHaveBeenCalledTimes(2)
    expect(worker.mock.calls[1]?.[0]).toEqual(["order", "--once", "--worker", "--resume", mission.id])
    expect(result.status).toBe("completed")
    expect(result.execution).toEqual(mission.execution)
    expect(orderExitCode(result)).toBe(0)
  })

  it.each(["expired", "cancelled", "blocked"] as const)(
    "preserves completed work when delivery is %s",
    async (kind) => {
      root = await mkdtemp(join(tmpdir(), "av-delivery-stop-"))
      const store = new MissionStore(join(root, ".agent-valley", "missions"))
      const mission = missionFixture()
      if (mission.supervision) mission.supervision.operatorGoal = mission.goal
      mission.executionPolicy = executionPolicySchema.parse({ maxDurationSec: 60 })
      mission.execution = {
        startedAt: new Date(Date.now() - (kind === "expired" ? 3_600_000 : 1_000)).toISOString(),
        runsStarted: 8,
        retries: 2,
      }
      mission.codeDelivery = {
        policy: {
          branch: "main",
          remote: "origin",
          paths: ["allowed.ts"],
          message: "fix: deliver",
          baseSha: "a".repeat(40),
        },
        phase: kind === "blocked" ? "blocked" : "pending",
        attempts: 1,
        updatedAt: new Date().toISOString(),
      }
      await store.save(mission)
      const controller = new AbortController()
      const worker = vi.fn().mockImplementation(async () => {
        if (kind === "cancelled") controller.abort()
        return 2
      })
      const result = await superviseOrder(undefined, { resume: mission.id }, root, {
        runWorker: worker,
        signal: controller.signal,
      })
      expect(result.status).toBe("completed")
      expect(result.codeDelivery?.phase).toBe("blocked")
      expect(result.execution).toEqual(mission.execution)
      expect(result.tasks).toEqual(mission.tasks)
      expect(worker).toHaveBeenCalledTimes(kind === "expired" ? 0 : 1)
    },
  )

  it("watches a completed Mission's pending delivery without starting a new goal", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "av-delivery-watch-")))
    const store = new MissionStore(join(root, ".agent-valley", "missions"))
    const mission = missionFixture()
    mission.executionPolicy = executionPolicySchema.parse({})
    mission.codeDelivery = {
      policy: {
        branch: "main",
        remote: "origin",
        paths: ["allowed.ts"],
        message: "fix: deliver",
        baseSha: "a".repeat(40),
      },
      phase: "pending",
      attempts: 1,
      updatedAt: new Date().toISOString(),
    }
    await store.save(mission)
    const controller = new AbortController()
    const resume = vi.fn<typeof superviseOrder>().mockImplementation(async (goal, options) => {
      expect(goal).toBeUndefined()
      expect(options).toEqual({ resume: mission.id })
      controller.abort()
      return mission
    })
    await watchOrders(root, { signal: controller.signal, mission: resume, delay: vi.fn().mockResolvedValue(undefined) })
    expect(resume).toHaveBeenCalledOnce()
  })

  it("bounds delivery worker crashes while preserving completed tasks and original spend", async () => {
    vi.useFakeTimers()
    root = await mkdtemp(join(tmpdir(), "av-delivery-worker-crash-"))
    const store = new MissionStore(join(root, ".agent-valley", "missions"))
    const mission = missionFixture()
    mission.executionPolicy = executionPolicySchema.parse({ maxRetries: 1 })
    mission.execution = { startedAt: new Date().toISOString(), runsStarted: 8, retries: 2 }
    mission.codeDelivery = {
      policy: {
        branch: "main",
        remote: "origin",
        paths: ["allowed.ts"],
        message: "fix: deliver",
        baseSha: "a".repeat(40),
      },
      phase: "pending",
      attempts: 0,
      updatedAt: new Date().toISOString(),
    }
    await store.save(mission)
    const worker = vi.fn().mockResolvedValue(1)
    const result = await superviseOrder(undefined, { resume: mission.id }, root, {
      runWorker: worker,
      delay: async (milliseconds) => {
        vi.setSystemTime(Date.now() + milliseconds)
      },
    })
    expect(worker).toHaveBeenCalledTimes(2)
    expect(result.status).toBe("completed")
    expect(result.tasks).toEqual(mission.tasks)
    expect(result.execution).toMatchObject({ ...mission.execution, crashRestarts: 2 })
    expect(result.codeDelivery?.phase).toBe("blocked")
  })
})
