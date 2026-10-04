import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executionPolicySchema } from "@agent-valley/core/chief/execution"
import { mission as missionFixture } from "@agent-valley/core/chief/reports.fixture"
import { MissionStore } from "@agent-valley/core/chief/store"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { abortableDelay, type OrderSupervisorDependencies, orderWorkerArgs, superviseOrder } from "../chief-supervisor"

vi.mock("@agent-valley/core/config/yaml-loader", () => ({
  loadGlobalConfig: vi.fn(() => null),
  loadProjectConfig: vi.fn(() => null),
}))

let root: string
let store: MissionStore
const now = Date.parse("2026-10-03T10:00:00Z")
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "av-supervised-order-"))
  store = new MissionStore(join(root, ".agent-valley", "missions"))
  vi.useFakeTimers()
  vi.setSystemTime(now)
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})
function checkpoint() {
  const mission = missionFixture()
  mission.status = "executing"
  mission.executionPolicy = executionPolicySchema.parse({ maxRetries: 2, maxRuns: 10 })
  mission.execution = { startedAt: new Date(now - 10_000).toISOString(), runsStarted: 4, retries: 1 }
  return mission
}
type Worker = NonNullable<OrderSupervisorDependencies["runWorker"]>

describe("durable order worker supervision", () => {
  it("preserves the API mission ID from supervisor launch through worker checkpoint", async () => {
    const assignedId = "api-owned-mission"
    const worker = vi.fn<Worker>().mockImplementation(async (args) => {
      expect(args).toContain(assignedId)
      expect(args.slice(-2)).toEqual(["--", "--actor literal-goal"])
      const saved = checkpoint()
      saved.id = assignedId
      saved.status = "completed"
      await store.save(saved)
      return 0
    })
    expect(
      (await superviseOrder("--actor literal-goal", { missionId: assignedId }, root, { runWorker: worker })).id,
    ).toBe(assignedId)
    expect(worker).toHaveBeenCalledTimes(1)
  })

  it("pauses at the mission deadline while awaiting a much later metric poll and writes a truthful report", async () => {
    const current = checkpoint()
    current.executionPolicy = executionPolicySchema.parse({ maxDurationSec: 60 })
    if (!current.execution) throw new Error("Expected execution checkpoint")
    current.execution.startedAt = new Date(now).toISOString()
    await store.save(current)
    vi.spyOn(console, "log").mockImplementation(() => {})
    const worker = vi.fn<Worker>().mockImplementation(async () => {
      const restored = await store.load(current.id)
      restored.status = "waiting"
      if (!restored.execution) throw new Error("Expected execution checkpoint")
      restored.execution.nextRunAt = new Date(now + 3_600_000).toISOString()
      await store.save(restored)
      return 0
    })
    const delay = vi.fn<typeof abortableDelay>().mockImplementation(async (milliseconds) => {
      vi.advanceTimersByTime(Math.min(milliseconds, 30_000))
    })
    const result = await superviseOrder(undefined, { resume: current.id }, root, { runWorker: worker, delay })
    expect(Date.now()).toBe(now + 60_000)
    expect(worker).toHaveBeenCalledTimes(1)
    expect(delay.mock.calls.map((call) => call[0])).toEqual([60_000, 30_000])
    expect(result.status).toBe("paused")
    expect(result.execution).toMatchObject({ failureKind: "budget", runsStarted: 4, retries: 1 })
    expect(result.execution?.nextRunAt).toBeUndefined()
    expect((await store.load(current.id)).status).toBe("paused")
    expect(await readFile(join(root, ".agent-valley", "reports", `${current.id}.md`), "utf8")).toContain(
      "Mission time limit reached",
    )
  })

  it("restarts a crashed worker from its persisted checkpoint while retaining completed tasks and spend", async () => {
    const current = checkpoint()
    await store.save(current)
    const worker = vi
      .fn<Worker>()
      .mockResolvedValueOnce(1)
      .mockImplementation(async () => {
        const restored = await store.load(current.id)
        expect(restored.execution).toMatchObject({
          runsStarted: 4,
          crashRestarts: 1,
          retries: 1,
          startedAt: current.execution?.startedAt,
        })
        expect(restored.tasks[0]?.status).toBe("completed")
        restored.status = "completed"
        await store.save(restored)
        return 0
      })
    const delay = vi.fn<typeof abortableDelay>().mockResolvedValue()
    const result = await superviseOrder(undefined, { resume: current.id }, root, { runWorker: worker, delay })
    expect(result.status).toBe("completed")
    expect(worker).toHaveBeenCalledTimes(2)
    expect(worker.mock.calls[1]?.[0]).toEqual(["order", "--worker", "--resume", current.id])
    expect(result.history.filter((event) => event.stage === "worker-restart")).toHaveLength(1)
    expect(delay).toHaveBeenCalledWith(1_000, expect.any(AbortSignal))
  })

  it("bounds repeated worker crashes and preserves the last checkpoint for operator retry", async () => {
    const current = checkpoint()
    await store.save(current)
    const worker = vi.fn<Worker>().mockResolvedValue(1)
    const result = await superviseOrder(undefined, { resume: current.id }, root, {
      runWorker: worker,
      delay: vi.fn<typeof abortableDelay>().mockResolvedValue(),
    })
    expect(result.status).toBe("paused")
    expect(result.execution).toMatchObject({ failureKind: "environment", crashRestarts: 3, runsStarted: 4 })
    expect(worker).toHaveBeenCalledTimes(3)
    expect((await store.load(current.id)).error).toContain("--retry")
  })

  it("waits until the saved metric/provider due time then resumes without initiating a new goal", async () => {
    const current = checkpoint()
    current.status = "waiting"
    if (!current.execution) throw new Error("Expected execution checkpoint")
    current.execution.nextRunAt = new Date(now + 65_000).toISOString()
    await store.save(current)
    const worker = vi
      .fn<Worker>()
      .mockResolvedValueOnce(0)
      .mockImplementation(async (args) => {
        expect(Date.now()).toBeGreaterThanOrEqual(now + 65_000)
        expect(args).toEqual(["order", "--worker", "--resume", current.id])
        const restored = await store.load(current.id)
        expect(restored.tasks[0]?.status).toBe("completed")
        expect(restored.execution?.runsStarted).toBe(4)
        restored.status = "completed"
        await store.save(restored)
        return 0
      })
    const delay = vi.fn<typeof abortableDelay>().mockImplementation(async (milliseconds) => {
      vi.advanceTimersByTime(Math.min(milliseconds, 30_000))
    })
    const result = await superviseOrder(undefined, { resume: current.id }, root, { runWorker: worker, delay })
    expect(result.status).toBe("completed")
    expect(delay).toHaveBeenCalledTimes(3)
    expect(result.execution?.crashRestarts).toBeUndefined()
    expect(worker).toHaveBeenCalledTimes(2)
  })

  it("joins an interrupted child before returning and never restarts after cancellation", async () => {
    const current = checkpoint()
    await store.save(current)
    const controller = new AbortController()
    let joined = false
    const worker = vi.fn<Worker>().mockImplementation(async (_args, _root, signal) => {
      await new Promise<void>((resolveExit) => {
        signal.addEventListener(
          "abort",
          () => {
            setTimeout(() => {
              joined = true
              resolveExit()
            }, 100)
          },
          { once: true },
        )
        controller.abort()
        vi.advanceTimersByTime(100)
      })
      return null
    })
    const result = await superviseOrder(undefined, { resume: current.id }, root, {
      runWorker: worker,
      signal: controller.signal,
    })
    expect(joined).toBe(true)
    expect(result.status).toBe("paused")
    expect(result.execution?.failureKind).toBe("interrupted")
    expect((await store.load(current.id)).status).toBe("paused")
    expect(result.execution?.runsStarted).toBe(4)
    expect(worker).toHaveBeenCalledTimes(1)
  })

  it("persists cancellation during a due-time wait so a watcher cannot restart the stopped goal", async () => {
    const current = checkpoint()
    await store.save(current)
    const controller = new AbortController()
    let enteredWait: () => void = () => {}
    const waiting = new Promise<void>((resolveWait) => {
      enteredWait = resolveWait
    })
    const worker = vi.fn<Worker>().mockImplementation(async () => {
      const restored = await store.load(current.id)
      restored.status = "waiting"
      if (!restored.execution) throw new Error("Expected execution checkpoint")
      restored.execution.nextRunAt = new Date(now + 65_000).toISOString()
      await store.save(restored)
      return 0
    })
    const delay = vi.fn<typeof abortableDelay>().mockImplementation(
      async (_milliseconds, signal) =>
        new Promise((_resolve, reject) => {
          const abort = () => reject(new Error("Order supervision interrupted."))
          signal?.addEventListener("abort", abort, { once: true })
          enteredWait()
          if (signal?.aborted) abort()
        }),
    )
    const pending = superviseOrder(undefined, { resume: current.id }, root, {
      runWorker: worker,
      delay,
      signal: controller.signal,
    })
    const stopped = pending.catch(() => undefined)
    await waiting
    controller.abort()
    await stopped
    const saved = await store.load(current.id)
    expect(saved.status).toBe("paused")
    expect(saved.execution).toMatchObject({ failureKind: "interrupted", runsStarted: 4 })
    expect(saved.execution?.nextRunAt).toBeUndefined()
    expect(saved.tasks[0]?.status).toBe("completed")
    expect(worker).toHaveBeenCalledTimes(1)
    expect(delay).toHaveBeenCalledTimes(1)
  })

  it("retains verified completion when cancellation arrives after the final worker checkpoint", async () => {
    const current = checkpoint()
    await store.save(current)
    const controller = new AbortController()
    const worker = vi.fn<Worker>().mockImplementation(async () => {
      const restored = await store.load(current.id)
      restored.status = "completed"
      await store.save(restored)
      controller.abort()
      return 0
    })
    const result = await superviseOrder(undefined, { resume: current.id }, root, {
      runWorker: worker,
      signal: controller.signal,
    })
    expect(result.status).toBe("completed")
    expect((await store.load(current.id)).status).toBe("completed")
    expect(worker).toHaveBeenCalledTimes(1)
  })

  it("does not replay initialization when the worker fails before creating any mission checkpoint", async () => {
    const worker = vi.fn<Worker>().mockResolvedValue(1)
    await expect(superviseOrder("Fix onboarding", {}, root, { runWorker: worker })).rejects.toThrow(
      "no automatic initialization replay",
    )
    expect(worker).toHaveBeenCalledTimes(1)
    expect(worker.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(["order", "Fix onboarding", "--worker", "--mission-id"]),
    )
  })

  it("returns an operator-paused mission and respects disabled automatic resume", async () => {
    const current = checkpoint()
    current.status = "paused"
    await store.save(current)
    const worker = vi.fn<Worker>().mockResolvedValue(0)
    expect((await superviseOrder(undefined, { resume: current.id }, root, { runWorker: worker })).status).toBe("paused")
    current.status = "executing"
    if (current.executionPolicy) current.executionPolicy.autoResume = false
    await store.save(current)
    expect((await superviseOrder(undefined, { resume: current.id }, root, { runWorker: worker })).status).toBe(
      "executing",
    )
    expect(worker).toHaveBeenCalledTimes(2)
  })
})

describe("worker arguments and cancellable scheduler waits", () => {
  it("retains explicit option values while keeping supervisor-only flags out of the child", () => {
    expect(
      orderWorkerArgs(
        "Goal with spaces",
        {
          workspace: "/repo with spaces",
          verify: "node --test test/login.test.js",
          actor: "codex",
          runs: "50",
          oma: true,
          worker: false,
          supervise: true,
          missionId: "ignored",
        },
        "assigned-id",
      ),
    ).toEqual([
      "order",
      "--worker",
      "--workspace",
      "/repo with spaces",
      "--verify",
      "node --test test/login.test.js",
      "--actor",
      "codex",
      "--runs",
      "50",
      "--oma",
      "--mission-id",
      "assigned-id",
      "--",
      "Goal with spaces",
    ])
  })

  it("caps each scheduler wait to 30 seconds and interrupts pending waits promptly", async () => {
    const pending = abortableDelay(600_000)
    vi.advanceTimersByTime(30_000)
    await expect(pending).resolves.toBeUndefined()
    const controller = new AbortController()
    const interrupted = abortableDelay(30_000, controller.signal)
    const rejection = expect(interrupted).rejects.toThrow("interrupted")
    controller.abort()
    await rejection
    expect(vi.getTimerCount()).toBe(0)
  })
})
