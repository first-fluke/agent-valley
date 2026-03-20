/**
 * RetryQueue tests — exponential backoff scheduling.
 */
import { describe, test, expect, beforeEach } from "bun:test"
import { RetryQueue } from "../orchestrator/retry-queue.ts"

describe("RetryQueue", () => {
  let queue: RetryQueue

  beforeEach(() => {
    // maxAttempts=3, backoffSec=60
    queue = new RetryQueue(3, 60)
  })

  test("add() returns true when under max attempts", () => {
    expect(queue.add("issue-1", 1, "timeout")).toBe(true)
    expect(queue.size).toBe(1)
  })

  test("add() returns false when at max attempts", () => {
    expect(queue.add("issue-1", 3, "timeout")).toBe(false)
    expect(queue.size).toBe(0)
  })

  test("add() returns false when over max attempts", () => {
    expect(queue.add("issue-1", 5, "timeout")).toBe(false)
  })

  test("drain() returns only entries past their nextRetryAt", () => {
    // Add an entry with attemptCount=1, backoff=60s * 2^0 = 60s in future
    queue.add("issue-future", 1, "err")

    // Entries added normally should be in the future — drain returns nothing
    const ready = queue.drain()
    expect(ready).toHaveLength(0)
    expect(queue.size).toBe(1)
  })

  test("drain() returns entries that are past due", () => {
    // Directly inject an entry with a past nextRetryAt
    queue.add("issue-past", 1, "err")

    // Hack: reach into the entries and set nextRetryAt to the past
    const entries = queue.entries
    expect(entries.length).toBe(1)

    // We need to remove and re-add with past time. Since the queue is private,
    // we'll create a fresh queue and manipulate via the public API with timing.
    const pastQueue = new RetryQueue(3, 0) // 0 second backoff
    pastQueue.add("issue-past", 1, "err") // delay = 0 * 2^0 = 0 seconds

    const ready = pastQueue.drain()
    expect(ready).toHaveLength(1)
    expect(ready[0]!.issueId).toBe("issue-past")
    expect(pastQueue.size).toBe(0)
  })

  test("drain() removes returned entries from queue", () => {
    const zeroQueue = new RetryQueue(3, 0)
    zeroQueue.add("a", 1, "err")
    zeroQueue.add("b", 1, "err")

    expect(zeroQueue.size).toBe(2)
    const ready = zeroQueue.drain()
    expect(ready).toHaveLength(2)
    expect(zeroQueue.size).toBe(0)
  })

  test("remove() filters by issueId", () => {
    queue.add("issue-1", 1, "err")
    queue.add("issue-2", 1, "err")
    expect(queue.size).toBe(2)

    queue.remove("issue-1")
    expect(queue.size).toBe(1)
    expect(queue.entries[0]!.issueId).toBe("issue-2")
  })

  test("remove() is a no-op for non-existent issueId", () => {
    queue.add("issue-1", 1, "err")
    queue.remove("nonexistent")
    expect(queue.size).toBe(1)
  })

  test("size getter returns correct count", () => {
    expect(queue.size).toBe(0)
    queue.add("a", 1, "e")
    expect(queue.size).toBe(1)
    queue.add("b", 2, "e")
    expect(queue.size).toBe(2)
    queue.remove("a")
    expect(queue.size).toBe(1)
  })

  test("backoff delay doubles with each attempt", () => {
    // backoffSec=60
    // attempt 1: delay = 60 * 2^0 = 60s
    // attempt 2: delay = 60 * 2^1 = 120s
    const q = new RetryQueue(5, 60)

    const now = Date.now()

    q.add("issue-1", 1, "err")
    const entry1 = q.entries[0]!
    const delay1 = new Date(entry1.nextRetryAt).getTime() - now

    q.remove("issue-1")
    q.add("issue-1", 2, "err")
    const entry2 = q.entries[0]!
    const delay2 = new Date(entry2.nextRetryAt).getTime() - now

    // delay2 should be roughly double delay1 (allow 2s tolerance for timing)
    expect(delay1).toBeGreaterThan(55_000) // ~60s
    expect(delay1).toBeLessThan(65_000)
    expect(delay2).toBeGreaterThan(115_000) // ~120s
    expect(delay2).toBeLessThan(125_000)
  })

  test("duplicate issueId updates existing entry (dedup)", () => {
    // Stream D dedup fix: duplicate issueId updates in place rather than accumulating.
    queue.add("issue-1", 1, "first error")
    queue.add("issue-1", 2, "second error")
    expect(queue.size).toBe(1)
    expect(queue.entries[0]!.attemptCount).toBe(2)
    expect(queue.entries[0]!.lastError).toBe("second error")
  })
})
