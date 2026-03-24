/**
 * SSE connection leak regression tests.
 *
 * Ensures the /api/events route properly cleans up intervals on disconnect
 * and does not leak setInterval handles.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

let mockOrchestrator: {
  getStatus: () => Record<string, unknown>
  on: (event: string, handler: (...args: unknown[]) => void) => void
  off: (event: string, handler: (...args: unknown[]) => void) => void
} | null = null

let getStatusCallCount = 0

vi.mock("@/lib/orchestrator-singleton", () => ({
  getOrchestrator: () => mockOrchestrator,
}))

vi.mock("@/lib/env", () => ({
  env: {
    AGENT_TYPE: "claude",
    MAX_PARALLEL: 3,
    SERVER_PORT: 9741,
  },
}))

const { GET: eventsGET } = await import("@/app/api/events/route")

describe("SSE /api/events — interval cleanup", () => {
  beforeEach(() => {
    getStatusCallCount = 0
    mockOrchestrator = {
      getStatus: () => {
        getStatusCallCount++
        return { isRunning: true, activeCount: 0 }
      },
      on: () => {},
      off: () => {},
    }
    vi.useFakeTimers()
  })

  afterEach(() => {
    mockOrchestrator = null
    vi.useRealTimers()
  })

  test("interval stops after stream is cancelled", async () => {
    const res = await eventsGET()
    const reader = res.body!.getReader()

    // Read initial events (state + keepalive)
    await reader.read()

    // Record call count before advancing time
    const countBeforeCancel = getStatusCallCount

    // Cancel the stream (simulates client disconnect)
    await reader.cancel()

    // Advance timers past several poll intervals
    vi.advanceTimersByTime(10_000)

    // getStatus should not have been called again after cancel
    expect(getStatusCallCount).toBe(countBeforeCancel)
  })

  test("interval self-terminates when send throws", async () => {
    const res = await eventsGET()
    const reader = res.body!.getReader()

    // Read initial events
    await reader.read()

    const countBeforeCancel = getStatusCallCount

    // Cancel reader (makes future enqueue throw)
    await reader.cancel()

    // Advance timers — interval should detect closed state and stop
    vi.advanceTimersByTime(10_000)

    expect(getStatusCallCount).toBe(countBeforeCancel)
  })

  test("multiple concurrent SSE connections each get their own cleanup", async () => {
    const res1 = await eventsGET()
    const res2 = await eventsGET()
    const reader1 = res1.body!.getReader()
    const reader2 = res2.body!.getReader()

    await reader1.read()
    await reader2.read()

    const countBefore = getStatusCallCount

    // Cancel only the first connection
    await reader1.cancel()

    // Advance one poll interval (5s fallback sync)
    vi.advanceTimersByTime(5_000)

    // Only one connection should still be polling (res2)
    // Exactly 1 new call from res2's interval
    expect(getStatusCallCount).toBe(countBefore + 1)

    await reader2.cancel()

    vi.advanceTimersByTime(10_000)

    // No more calls after both are cancelled
    expect(getStatusCallCount).toBe(countBefore + 1)
  })
})
