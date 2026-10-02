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
  toOrchestratorConfig: () => ({
    agentType: "claude",
    maxParallel: 3,
    serverPort: 9741,
  }),
}))

const { GET: eventsGET } = await import("@/app/api/events/route")

const localRequest = () => new Request("http://localhost:3000/api/events", { headers: { host: "localhost:3000" } })

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
    const res = await eventsGET(localRequest())
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
    const res = await eventsGET(localRequest())
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
    const res1 = await eventsGET(localRequest())
    const res2 = await eventsGET(localRequest())
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

  test("startup failure reports unavailable instead of sending invalid configuration as state", async () => {
    mockOrchestrator = null
    const response = await eventsGET(localRequest())
    const reader = response.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain("event: unavailable")
    expect(first).toContain("av doctor")
    expect(first).not.toContain("event: state")
    expect(first).not.toContain('"config":{}')
    await reader.cancel()
  })

  test("a connection opened before startup observes a runtime that appears later", async () => {
    mockOrchestrator = null
    const response = await eventsGET(localRequest())
    const reader = response.body!.getReader()
    await reader.read()
    await reader.read()
    mockOrchestrator = { getStatus: () => ({ isRunning: true, activeAgents: 2 }), on: vi.fn(), off: vi.fn() }
    vi.advanceTimersByTime(5_000)
    const next = new TextDecoder().decode((await reader.read()).value)
    expect(next).toContain("event: state")
    expect(next).toContain('"activeAgents":2')
    expect(mockOrchestrator.on).toHaveBeenCalledTimes(7)
    await reader.cancel()
  })

  test("hot reload detaches the previous instance and subscribes to its replacement", async () => {
    const previous = { getStatus: () => ({ isRunning: false }), on: vi.fn(), off: vi.fn() }
    mockOrchestrator = previous
    const response = await eventsGET(localRequest())
    const reader = response.body!.getReader()
    await reader.read()
    await reader.read()
    const replacement = { getStatus: () => ({ isRunning: true, activeAgents: 3 }), on: vi.fn(), off: vi.fn() }
    mockOrchestrator = replacement
    vi.advanceTimersByTime(5_000)
    const next = new TextDecoder().decode((await reader.read()).value)
    expect(next).toContain('"activeAgents":3')
    expect(previous.off).toHaveBeenCalledTimes(7)
    expect(replacement.on).toHaveBeenCalledTimes(7)
    await reader.cancel()
    expect(replacement.off).toHaveBeenCalledTimes(7)
  })

  test("aborting the request releases event listeners and timers without waiting for stream cancellation", async () => {
    const controller = new AbortController()
    const off = vi.fn()
    mockOrchestrator = { getStatus: () => ({ isRunning: true }), on: vi.fn(), off }
    const response = await eventsGET(
      new Request("http://localhost/api/events", { headers: { host: "localhost" }, signal: controller.signal }),
    )
    const reader = response.body!.getReader()
    await reader.read()
    await reader.read()
    controller.abort()
    expect(off).toHaveBeenCalledTimes(7)
    expect(vi.getTimerCount()).toBe(0)
    expect((await reader.read()).done).toBe(true)
  })
})
