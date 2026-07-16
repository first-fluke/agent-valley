/**
 * RetryQueue tests — exponential backoff scheduling.
 */
import { beforeEach, describe, expect, test } from "vitest"
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
    expect(ready[0]?.issueId).toBe("issue-past")
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
    expect(queue.entries[0]?.issueId).toBe("issue-2")
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
    // rng()=1 pins jitter to its upper bound (= the uncapped raw delay), isolating the doubling math from jitter.
    const q = new RetryQueue(5, 60, () => 1)

    const now = Date.now()

    q.add("issue-1", 1, "err")
    const entry1 = q.entries[0]
    const delay1 = new Date(entry1?.nextRetryAt ?? 0).getTime() - now

    q.remove("issue-1")
    q.add("issue-1", 2, "err")
    const entry2 = q.entries[0]
    const delay2 = new Date(entry2?.nextRetryAt ?? 0).getTime() - now

    // delay2 should be roughly double delay1 (allow 2s tolerance for timing)
    expect(delay1).toBeGreaterThan(55_000) // ~60s
    expect(delay1).toBeLessThan(65_000)
    expect(delay2).toBeGreaterThan(115_000) // ~120s
    expect(delay2).toBeLessThan(125_000)
  })

  test("attemptCount=0 uses full backoff (no fractional exponent)", () => {
    const q = new RetryQueue(5, 60, () => 1) // rng()=1 pins jitter to its upper bound
    const now = Date.now()
    q.add("issue-0", 0, "queued")
    const delay = new Date(q.entries[0]?.nextRetryAt ?? 0).getTime() - now
    // Previously 2 ** (0-1) = 0.5 made delay ~30s; clamped to 2 ** 0 = 1 → ~60s.
    expect(delay).toBeGreaterThan(55_000)
    expect(delay).toBeLessThan(65_000)
  })

  test("duplicate issueId updates existing entry (dedup)", () => {
    // Stream D dedup fix: duplicate issueId updates in place rather than accumulating.
    queue.add("issue-1", 1, "first error")
    queue.add("issue-1", 2, "second error")
    expect(queue.size).toBe(1)
    expect(queue.entries[0]?.attemptCount).toBe(2)
    expect(queue.entries[0]?.lastError).toBe("second error")
  })

  test("add() without a category defaults to 'infra'", () => {
    queue.add("issue-1", 1, "err")
    expect(queue.entries[0]?.category).toBe("infra")
  })

  describe("jitter", () => {
    test("jittered delay stays within [delay/2, delay] for a fixed RNG output", () => {
      // backoffSec=60, attemptCount=1 -> raw delay = 60s. half=30s.
      // rng()=0 -> actual = 30s (lower bound). rng()=0.999... -> actual ~= 60s (upper bound).
      const lowQueue = new RetryQueue(5, 60, () => 0)
      const now = Date.now()
      lowQueue.add("issue-low", 1, "err")
      const lowDelay = new Date(lowQueue.entries[0]?.nextRetryAt ?? 0).getTime() - now
      expect(lowDelay).toBeGreaterThanOrEqual(29_000)
      expect(lowDelay).toBeLessThan(31_000)

      const highQueue = new RetryQueue(5, 60, () => 0.999999)
      highQueue.add("issue-high", 1, "err")
      const highDelay = new Date(highQueue.entries[0]?.nextRetryAt ?? 0).getTime() - now
      expect(highDelay).toBeGreaterThan(59_000)
      expect(highDelay).toBeLessThanOrEqual(60_500)
    })

    test("jittered delay for random RNG samples always falls within [delay/2, delay] bounds", () => {
      // backoffSec=10, attemptCount=3 -> raw delay = 10 * 2^2 = 40s. Bounds: [20s, 40s].
      for (const sample of [0, 0.25, 0.5, 0.75, 0.999]) {
        const q = new RetryQueue(10, 10, () => sample)
        const now = Date.now()
        q.add("issue-1", 3, "err")
        const delay = new Date(q.entries[0]?.nextRetryAt ?? 0).getTime() - now
        expect(delay).toBeGreaterThanOrEqual(19_500)
        expect(delay).toBeLessThanOrEqual(40_500)
      }
    })

    test("backoff is capped at the max ceiling before jitter is applied", () => {
      // backoffSec=1000, attemptCount=10 -> raw delay would be enormous; capped to maxBackoffSec=100.
      // rng()=0.999999 -> actual should approach the 100s ceiling, never the uncapped raw value.
      const q = new RetryQueue(20, 1000, () => 0.999999, 100)
      const now = Date.now()
      q.add("issue-1", 10, "err")
      const delay = new Date(q.entries[0]?.nextRetryAt ?? 0).getTime() - now
      expect(delay).toBeLessThanOrEqual(100_500)
      expect(delay).toBeGreaterThan(90_000)
    })
  })

  describe("category-based max-attempts policy", () => {
    test("infra category uses the full configured maxAttempts", () => {
      const q = new RetryQueue(5, 0)
      expect(q.add("issue-1", 4, "err", "infra")).toBe(true)
      expect(q.add("issue-2", 5, "err", "infra")).toBe(false)
    })

    test("verification category uses the full configured maxAttempts", () => {
      const q = new RetryQueue(5, 0)
      expect(q.add("issue-1", 4, "err", "verification")).toBe(true)
      expect(q.add("issue-2", 5, "err", "verification")).toBe(false)
    })

    test("capability category caps retries earlier than infra (default cap of 2)", () => {
      const q = new RetryQueue(5, 0)
      expect(q.add("issue-1", 1, "err", "capability")).toBe(true)
      // infra would still allow attemptCount=2,3,4 (maxAttempts=5); capability stops at 2.
      expect(q.add("issue-1", 2, "err", "capability")).toBe(false)
    })

    test("capability cap never exceeds the configured maxAttempts when maxAttempts is smaller", () => {
      const q = new RetryQueue(1, 0)
      expect(q.add("issue-1", 0, "err", "capability")).toBe(true)
      expect(q.add("issue-1", 1, "err", "capability")).toBe(false)
    })
  })

  describe("category persistence through dedup", () => {
    test("dedup update overwrites the category with the latest classification", () => {
      const q = new RetryQueue(5, 0)
      q.add("issue-1", 1, "first error", "infra")
      expect(q.entries[0]?.category).toBe("infra")
      q.add("issue-1", 1, "second error", "verification")
      expect(q.size).toBe(1)
      expect(q.entries[0]?.category).toBe("verification")
      expect(q.entries[0]?.lastError).toBe("second error")
    })
  })
})
