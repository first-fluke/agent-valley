import { describe, expect, it } from "vitest"
import { readyTaskWave, runJoinedWave } from "./parallel"
import type { ChiefPlan, ChiefTaskState } from "./types"

function barrier() {
  let release: () => void = () => {}
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}
const task = (id: string, dependencies: string[] = []) => ({
  id,
  title: id,
  personaId: id,
  instructions: id,
  acceptance: [id],
  dependencies,
})
const state = (id: string, status: ChiefTaskState["status"]): ChiefTaskState => ({
  id,
  status,
  attempts: 0,
  reviewerId: "reviewer",
})

describe("dependency-ready parallel waves", () => {
  it("waits for completed independent reviews and preserves plan order", () => {
    const plan: ChiefPlan = { tasks: [task("first"), task("second"), task("dependent", ["first"])] }
    expect(readyTaskWave(plan, [state("first", "reviewing")], 2).map((entry) => entry.id)).toEqual(["first", "second"])
    expect(readyTaskWave(plan, [state("first", "completed")], 2).map((entry) => entry.id)).toEqual([
      "second",
      "dependent",
    ])
    expect(readyTaskWave(plan, [state("first", "completed")], 1).map((entry) => entry.id)).toEqual(["second"])
    expect(() => readyTaskWave(plan, [], 0)).toThrow("between 1 and 20")
  })

  it("actually overlaps independent children and returns results in input order", async () => {
    const bothStarted = barrier()
    const finish = barrier()
    const started: number[] = []
    const running = runJoinedWave([1, 2], async (id) => {
      started.push(id)
      if (started.length === 2) bothStarted.release()
      await finish.wait
      return id
    })
    await bothStarted.wait
    expect(started).toEqual([1, 2])
    finish.release()
    expect(await running).toEqual([
      { status: "fulfilled", value: 1 },
      { status: "fulfilled", value: 2 },
    ])
  })

  it("joins other children before exposing a failure to recovery", async () => {
    const blocked = barrier()
    const entered = barrier()
    let settled = false
    const running = runJoinedWave(["failed", "running"], async (id) => {
      if (id === "failed") throw new Error("Actor rejected")
      entered.release()
      await blocked.wait
      return id
    }).then((results) => {
      settled = true
      return results
    })
    await entered.wait
    expect(settled).toBe(false)
    blocked.release()
    const results = await running
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"])
  })

  it("propagates abort to every child and waits for each cleanup barrier", async () => {
    const controller = new AbortController()
    const started = barrier()
    const cleanup = barrier()
    let count = 0
    let joined = false
    const events: string[] = []
    const running = runJoinedWave(
      ["a", "b"],
      async (id, signal) => {
        count++
        if (count === 2) started.release()
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
        events.push(`aborted:${id}`)
        await cleanup.wait
        events.push(`closed:${id}`)
        signal.throwIfAborted()
      },
      controller.signal,
    ).then((results) => {
      joined = true
      return results
    })
    await started.wait
    controller.abort(new Error("Operator interrupted"))
    await Promise.resolve()
    expect(events).toEqual(["aborted:a", "aborted:b"])
    expect(joined).toBe(false)
    cleanup.release()
    expect((await running).every((result) => result.status === "rejected")).toBe(true)
    expect(events).toEqual(["aborted:a", "aborted:b", "closed:a", "closed:b"])
  })

  it("does not start children after an already recorded abort", async () => {
    const controller = new AbortController()
    controller.abort(new Error("Interrupted"))
    let started = false
    await expect(
      runJoinedWave(
        [1],
        async () => {
          started = true
        },
        controller.signal,
      ),
    ).rejects.toThrow("Interrupted")
    expect(started).toBe(false)
  })
})
