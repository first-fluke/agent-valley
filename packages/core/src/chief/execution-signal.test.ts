import { afterEach, describe, expect, it, vi } from "vitest"
import { executionPolicySchema, MissionPause } from "./execution"
import { withMissionDeadline } from "./execution-signal"
import type { Mission } from "./types"

function fixture(): Mission {
  return {
    id: "deadline-test",
    goal: "Complete the goal",
    chiefId: "chief",
    personas: [],
    workspace: {
      issueId: "deadline-test",
      path: "/workspace",
      key: "deadline-test",
      branch: "chief/test",
      status: "idle",
      createdAt: "2026-10-03",
    },
    verifyCommand: "git diff --check",
    timeoutSec: 600,
    maxRepairs: 0,
    status: "pending",
    createdAt: "2026-10-03",
    updatedAt: "2026-10-03",
    tasks: [],
    history: [],
    executionPolicy: executionPolicySchema.parse({ maxDurationSec: 1 }),
    execution: { startedAt: new Date(Date.now() - 750).toISOString(), runsStarted: 0, retries: 0 },
  }
}
afterEach(() => vi.useRealTimers())

describe("mission remaining wall-time deadline", () => {
  it("cancels at the remaining total time and awaits operation cleanup before rejecting", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-03T10:00:00Z"))
    let aborted = false
    let joined = false
    let settled = false
    const pending = withMissionDeadline(
      fixture(),
      undefined,
      (signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true
              setTimeout(() => {
                joined = true
                reject(signal.reason)
              }, 25)
            },
            { once: true },
          )
        }),
    )
    const result = pending.then(
      () => {
        settled = true
        return undefined
      },
      (error: unknown) => {
        settled = true
        return error
      },
    )
    await vi.advanceTimersByTimeAsync(249)
    expect(aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(aborted).toBe(true)
    expect(joined).toBe(false)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(25)
    const error = await result
    expect(error).toBeInstanceOf(MissionPause)
    expect((error as MissionPause).kind).toBe("budget")
    expect(joined).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("forwards the parent's original abort reason and removes listeners", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, "removeEventListener")
    const reason = new Error("Operator stopped this mission")
    const pending = withMissionDeadline(
      fixture(),
      controller.signal,
      (signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
        }),
    )
    const result = pending.catch((error: unknown) => error)
    controller.abort(reason)
    expect(await result).toBe(reason)
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })

  it("passes an already-aborted parent reason to the operation", async () => {
    const reason = new Error("Already cancelled")
    const run = vi.fn(async (signal) => {
      expect(signal.aborted).toBe(true)
      throw signal.reason
    })
    await expect(withMissionDeadline(fixture(), AbortSignal.abort(reason), run)).rejects.toBe(reason)
    expect(run).toHaveBeenCalledOnce()
  })

  it("preserves legacy signals and creates no deadline without a policy", async () => {
    vi.useFakeTimers()
    const mission = fixture()
    delete mission.executionPolicy
    const signal = new AbortController().signal
    const run = vi.fn(async (received) => {
      expect(received).toBe(signal)
      return "legacy"
    })
    expect(await withMissionDeadline(mission, signal, run)).toBe("legacy")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("rejects a deadline already spent before dispatching an operation", async () => {
    const mission = fixture()
    mission.execution = { startedAt: new Date(Date.now() - 1_001).toISOString(), runsStarted: 0, retries: 0 }
    const run = vi.fn(async () => "must not run")
    await expect(withMissionDeadline(mission, undefined, run)).rejects.toMatchObject({ kind: "budget" })
    expect(run).not.toHaveBeenCalled()
  })

  it("clears its deadline after ordinary operation success or failure", async () => {
    vi.useFakeTimers()
    expect(await withMissionDeadline(fixture(), undefined, async () => "done")).toBe("done")
    expect(vi.getTimerCount()).toBe(0)
    const reason = new Error("Implementation failure")
    await expect(
      withMissionDeadline(fixture(), undefined, async () => {
        throw reason
      }),
    ).rejects.toBe(reason)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("preserves deadline reason when an adapter resolves a cancellation result after cleanup", async () => {
    vi.useFakeTimers()
    let joined = false
    const pending = withMissionDeadline(
      fixture(),
      undefined,
      (signal) =>
        new Promise((resolve) => {
          signal?.addEventListener(
            "abort",
            () =>
              setTimeout(() => {
                joined = true
                resolve({ ok: false })
              }, 25),
            { once: true },
          )
        }),
    )
    const result = pending.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(275)
    expect(await result).toMatchObject({ kind: "budget" })
    expect(joined).toBe(true)
  })

  it("preserves parent reason when an adapter rejects a generic cancellation error", async () => {
    const controller = new AbortController()
    const reason = new Error("Operator stopped the mission")
    const pending = withMissionDeadline(
      fixture(),
      controller.signal,
      (signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("Generic adapter cancelled")), { once: true })
        }),
    )
    const result = pending.catch((error: unknown) => error)
    controller.abort(reason)
    expect(await result).toBe(reason)
  })
})
