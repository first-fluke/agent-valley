import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createOrderRunGuard } from "./order-run-guard"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("owned order teardown", () => {
  let root: string
  let evidence: string
  let releases: Array<() => void>
  let jobs: Promise<unknown>[]
  let listeners: Array<(signal: NodeJS.Signals) => void>

  function signalPair(listener: (signal: NodeJS.Signals) => void) {
    process.once("SIGINT", listener)
    process.once("SIGTERM", listener)
    listeners.push(listener)
    return () => {
      process.removeListener("SIGINT", listener)
      process.removeListener("SIGTERM", listener)
    }
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "av-order-teardown-"))
    evidence = join(root, "evidence.txt")
    await writeFile(evidence, "retained until joined")
    releases = []
    jobs = []
    listeners = []
  })

  afterEach(async () => {
    for (const release of releases) release()
    await Promise.allSettled(jobs)
    for (const listener of listeners) {
      process.removeListener("SIGINT", listener)
      process.removeListener("SIGTERM", listener)
    }
    vi.useRealTimers()
    await rm(root, { recursive: true, force: true })
  })

  it("prevents a timed-out body from launching a late resume after teardown has started", async () => {
    const order = createOrderRunGuard()
    const observers = process.listeners("newListener")
    const unrelatedObserver = vi.fn()
    const originalOnce = process.once
    const result = order.run(async () => undefined)
    process.on("newListener", unrelatedObserver)
    try {
      await result
      expect(process.listeners("newListener")).toEqual([...observers, unrelatedObserver])
      expect(process.once).toBe(originalOnce)
    } finally {
      process.removeListener("newListener", unrelatedObserver)
    }
    await order.stopAndJoin()
    const launch = vi.fn(async () => undefined)
    expect(() => order.run(launch)).toThrow("Order teardown has started")
    expect(launch).not.toHaveBeenCalled()
  })

  it("interrupts only its order and joins delayed cleanup before restoring mocks or deleting the fixture", async () => {
    const unrelated = vi.fn()
    signalPair(unrelated)
    const order = createOrderRunGuard()
    const register = deferred()
    const stopped = deferred()
    const finish = deferred()
    releases.push(register.resolve, stopped.resolve, finish.resolve)
    const events: string[] = []
    const result = order.run(async () => {
      await register.promise
      const remove = signalPair(() => {
        events.push("interrupted")
        stopped.resolve()
      })
      try {
        await stopped.promise
        await finish.promise
        events.push("joined")
      } finally {
        remove()
      }
    })
    jobs.push(result)
    const laterUnrelated = vi.fn()
    signalPair(laterUnrelated)
    const cleanup = order.stopAndJoin().then(async () => {
      events.push("restore mocks")
      await rm(root, { recursive: true, force: true })
    })
    jobs.push(cleanup)
    expect(laterUnrelated).not.toHaveBeenCalled()
    register.resolve()
    await stopped.promise
    expect(await readFile(evidence, "utf8")).toBe("retained until joined")
    expect(events).toEqual(["interrupted"])
    expect(unrelated).not.toHaveBeenCalled()
    expect(laterUnrelated).not.toHaveBeenCalled()
    finish.resolve()
    await cleanup
    expect(events).toEqual(["interrupted", "joined", "restore mocks"])
    await expect(readFile(evidence)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("retains the fixture and rejects when the interrupted order cannot join", async () => {
    vi.useFakeTimers()
    const order = createOrderRunGuard(20)
    const observers = process.listeners("newListener")
    const registered = deferred()
    const finish = deferred()
    releases.push(finish.resolve)
    const interrupted = vi.fn()
    const result = order.run(async () => {
      const remove = signalPair(interrupted)
      registered.resolve()
      try {
        await finish.promise
      } finally {
        remove()
      }
    })
    jobs.push(result)
    await registered.promise
    expect(process.listeners("newListener")).toHaveLength(observers.length + 1)
    const cleanup = order.stopAndJoin().then(() => rm(root, { recursive: true, force: true }))
    jobs.push(cleanup)
    const rejected = expect(cleanup).rejects.toThrow("The fixture was retained")
    await vi.advanceTimersByTimeAsync(21)
    await rejected
    expect(process.listeners("newListener")).toEqual(observers)
    expect(interrupted).toHaveBeenCalledOnce()
    expect(await readFile(evidence, "utf8")).toBe("retained until joined")
    finish.resolve()
    await result
  })

  it("preserves the fixture when the order reports cleanup failure", async () => {
    const order = createOrderRunGuard()
    const observers = process.listeners("newListener")
    const registered = deferred()
    const stopped = deferred()
    releases.push(stopped.resolve)
    const failure = new Error("Actor cleanup is unconfirmed")
    const result = order.run(async () => {
      const remove = signalPair(stopped.resolve)
      registered.resolve()
      try {
        await stopped.promise
        throw failure
      } finally {
        remove()
      }
    })
    jobs.push(result)
    // The test body observes the original failure; teardown independently preserves it.
    const rejected = expect(result).rejects.toBe(failure)
    await registered.promise
    const cleanup = order.stopAndJoin().then(() => rm(root, { recursive: true, force: true }))
    jobs.push(cleanup)
    await expect(cleanup).rejects.toBe(failure)
    await rejected
    expect(process.listeners("newListener")).toEqual(observers)
    expect(await readFile(evidence, "utf8")).toBe("retained until joined")
  })
})
