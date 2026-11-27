import { describe, expect, it, vi } from "vitest"
import type { VerificationGateOptions, VerificationGateResult } from "../orchestrator/verification-gate"
import {
  LANE_CHECK_COMMAND_ENV,
  LANE_CHECK_CONCURRENCY_ENV,
  laneCheckConcurrency,
  laneCheckSemaphoreCount,
  runLaneCheck,
} from "./runtime-integration-check"
import type { Mission } from "./types"

function makeMission(id: string, repositoryRoot: string): Mission {
  return {
    id,
    repositoryRoot,
    workspace: {
      path: `${repositoryRoot}/work`,
      branch: `mission/${id}`,
      issueId: id,
    },
  } as Mission
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("laneCheckConcurrency", () => {
  it("defaults to 1, parses valid positive integers, clamps to 16, and rejects invalid values", () => {
    expect(laneCheckConcurrency({})).toBe(1)
    expect(laneCheckConcurrency({ [LANE_CHECK_CONCURRENCY_ENV]: "1" })).toBe(1)
    expect(laneCheckConcurrency({ [LANE_CHECK_CONCURRENCY_ENV]: " 3 " })).toBe(3)
    expect(laneCheckConcurrency({ [LANE_CHECK_CONCURRENCY_ENV]: "99" })).toBe(16)
    for (const invalid of ["", "   ", "0", "-1", "1.5", "abc", "2px", "Infinity"]) {
      expect(laneCheckConcurrency({ [LANE_CHECK_CONCURRENCY_ENV]: invalid })).toBe(1)
    }
  })
})

describe("runLaneCheck concurrency semaphore", () => {
  it("serializes concurrent calls for the same repository by default (max concurrent === 1)", async () => {
    const mission = makeMission("m-serial", "/repos/serial")
    let active = 0
    let maxConcurrent = 0
    const order: string[] = []
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()]
    let callIndex = 0

    const runGate = vi.fn(
      async (_workspace: Mission["workspace"], command: string | undefined): Promise<VerificationGateResult> => {
        const idx = callIndex++
        active += 1
        maxConcurrent = Math.max(maxConcurrent, active)
        order.push(`start:${idx}`)
        await gates[idx]?.promise
        order.push(`end:${idx}`)
        active -= 1
        return { ran: true, ok: true, command, output: "" }
      },
    )

    const env = { [LANE_CHECK_COMMAND_ENV]: "cargo clippy --workspace" }
    const p1 = runLaneCheck(mission, "/repos/serial/w1", undefined, env, { runGate })
    const p2 = runLaneCheck(mission, "/repos/serial/w2", undefined, env, { runGate })
    const p3 = runLaneCheck(mission, "/repos/serial/w3", undefined, env, { runGate })

    await vi.waitFor(() => expect(runGate).toHaveBeenCalledTimes(1))
    expect(active).toBe(1)
    gates[0]?.resolve()

    await vi.waitFor(() => expect(runGate).toHaveBeenCalledTimes(2))
    expect(active).toBe(1)
    gates[1]?.resolve()

    await vi.waitFor(() => expect(runGate).toHaveBeenCalledTimes(3))
    expect(active).toBe(1)
    gates[2]?.resolve()

    const results = await Promise.all([p1, p2, p3])
    expect(results.every((r) => r?.ok === true)).toBe(true)
    expect(maxConcurrent).toBe(1)
    expect(order).toEqual(["start:0", "end:0", "start:1", "end:1", "start:2", "end:2"])
    expect(laneCheckSemaphoreCount()).toBe(0)
  })

  it("allows up to AV_LANE_CHECK_CONCURRENCY=2 concurrent calls for the same repository", async () => {
    const mission = makeMission("m-two", "/repos/two")
    let active = 0
    let maxConcurrent = 0
    const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()]
    let callIndex = 0

    const runGate = vi.fn(
      async (_workspace: Mission["workspace"], command: string | undefined): Promise<VerificationGateResult> => {
        const idx = callIndex++
        active += 1
        maxConcurrent = Math.max(maxConcurrent, active)
        await gates[idx]?.promise
        active -= 1
        return { ran: true, ok: true, command, output: "" }
      },
    )

    const env = {
      [LANE_CHECK_COMMAND_ENV]: "cargo clippy",
      [LANE_CHECK_CONCURRENCY_ENV]: "2",
    }
    const calls = [0, 1, 2, 3].map((i) => runLaneCheck(mission, `/repos/two/w${i}`, undefined, env, { runGate }))

    await vi.waitFor(() => expect(runGate).toHaveBeenCalledTimes(2))
    expect(active).toBe(2)

    gates[0]?.resolve()
    await vi.waitFor(() => expect(runGate).toHaveBeenCalledTimes(3))
    expect(active).toBe(2)

    gates[1]?.resolve()
    await vi.waitFor(() => expect(runGate).toHaveBeenCalledTimes(4))
    expect(active).toBe(2)

    gates[2]?.resolve()
    gates[3]?.resolve()

    const results = await Promise.all(calls)
    expect(results.every((r) => r?.ok === true)).toBe(true)
    expect(maxConcurrent).toBe(2)
    expect(laneCheckSemaphoreCount()).toBe(0)
  })

  it("does not block different repositories against each other", async () => {
    const repoA = makeMission("m-a", "/repos/a")
    const repoB = makeMission("m-b", "/repos/b")
    let active = 0
    let maxConcurrent = 0
    const gateA = deferred<void>()
    const gateB = deferred<void>()

    const runGate = vi.fn(
      async (workspace: Mission["workspace"], command: string | undefined): Promise<VerificationGateResult> => {
        active += 1
        maxConcurrent = Math.max(maxConcurrent, active)
        await (workspace.path.startsWith("/repos/a") ? gateA.promise : gateB.promise)
        active -= 1
        return { ran: true, ok: true, command, output: "" }
      },
    )

    const env = { [LANE_CHECK_COMMAND_ENV]: "cargo clippy" }
    const pA = runLaneCheck(repoA, "/repos/a/w1", undefined, env, { runGate })
    const pB = runLaneCheck(repoB, "/repos/b/w1", undefined, env, { runGate })

    await vi.waitFor(() => expect(runGate).toHaveBeenCalledTimes(2))
    expect(maxConcurrent).toBe(2)

    gateA.resolve()
    gateB.resolve()
    await Promise.all([pA, pB])
    expect(laneCheckSemaphoreCount()).toBe(0)
  })

  it("aborts a queued call immediately without running it or leaking the semaphore slot", async () => {
    const mission = makeMission("m-abort", "/repos/abort")
    const gateFirst = deferred<void>()
    const spawnedWorkspaces: string[] = []

    const runGate = vi.fn(
      async (
        workspace: Mission["workspace"],
        command: string | undefined,
        _opts?: VerificationGateOptions,
      ): Promise<VerificationGateResult> => {
        spawnedWorkspaces.push(workspace.path)
        if (workspace.path.endsWith("/w1")) await gateFirst.promise
        return { ran: true, ok: true, command, output: "" }
      },
    )

    const env = { [LANE_CHECK_COMMAND_ENV]: "cargo clippy" }
    const p1 = runLaneCheck(mission, "/repos/abort/w1", undefined, env, { runGate })
    await vi.waitFor(() => expect(spawnedWorkspaces).toEqual(["/repos/abort/w1"]))

    const controller = new AbortController()
    const pQueued = runLaneCheck(mission, "/repos/abort/w2", controller.signal, env, { runGate })
    const p3 = runLaneCheck(mission, "/repos/abort/w3", undefined, env, { runGate })

    controller.abort()
    const abortedResult = await pQueued
    expect(abortedResult?.ok).toBe(false)
    expect(abortedResult?.output).toContain("Verification cancelled.")
    expect(spawnedWorkspaces).toEqual(["/repos/abort/w1"])

    gateFirst.resolve()
    const [r1, r3] = await Promise.all([p1, p3])
    expect(r1?.ok).toBe(true)
    expect(r3?.ok).toBe(true)
    expect(spawnedWorkspaces).toEqual(["/repos/abort/w1", "/repos/abort/w3"])
    expect(laneCheckSemaphoreCount()).toBe(0)
  })

  it("handles pre-aborted signals without spawning or leaking semaphore entries", async () => {
    const mission = makeMission("m-preabort", "/repos/preabort")
    const controller = new AbortController()
    controller.abort()
    const runGate = vi.fn()

    const result = await runLaneCheck(
      mission,
      "/repos/preabort/w1",
      controller.signal,
      { [LANE_CHECK_COMMAND_ENV]: "cargo clippy" },
      { runGate },
    )
    expect(result?.ok).toBe(false)
    expect(result?.output).toContain("Verification cancelled.")
    expect(runGate).not.toHaveBeenCalled()
    expect(laneCheckSemaphoreCount()).toBe(0)
  })

  it("releases the slot cleanly when a lane check fails or throws", async () => {
    const mission = makeMission("m-error", "/repos/error")
    const gate1 = deferred<void>()
    let call = 0

    const runGate = vi.fn(
      async (_workspace: Mission["workspace"], command: string | undefined): Promise<VerificationGateResult> => {
        call += 1
        if (call === 1) {
          await gate1.promise
          throw new Error("boom")
        }
        if (call === 2) {
          return { ran: true, ok: false, command, output: "clippy error", timedOut: false }
        }
        return { ran: true, ok: true, command, output: "" }
      },
    )

    const env = { [LANE_CHECK_COMMAND_ENV]: "cargo clippy" }
    const p1 = runLaneCheck(mission, "/repos/error/w1", undefined, env, { runGate })
    const p2 = runLaneCheck(mission, "/repos/error/w2", undefined, env, { runGate })
    const p3 = runLaneCheck(mission, "/repos/error/w3", undefined, env, { runGate })

    await vi.waitFor(() => expect(runGate).toHaveBeenCalledTimes(1))
    gate1.resolve()

    await expect(p1).rejects.toThrow("boom")
    const [r2, r3] = await Promise.all([p2, p3])
    expect(r2?.ok).toBe(false)
    expect(r2?.output).toContain("clippy error")
    expect(r3?.ok).toBe(true)
    expect(laneCheckSemaphoreCount()).toBe(0)
  })
})
