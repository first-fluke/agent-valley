import { afterEach, describe, expect, it } from "vitest"
import {
  hostResumedSince,
  hostResumedWithin,
  hostStablyAwake,
  isHostSleepArtefact,
  observeHostClock,
  STABLE_WAKE_MS,
  SUSPENSION_WINDOW_MS,
  watchHostSuspension,
} from "./host-suspension"

const start = Date.parse("2026-11-17T00:00:00Z")
let stop: (() => void) | undefined
afterEach(() => {
  stop?.()
  stop = undefined
})

describe("host suspension", () => {
  it("stays inactive until the order command starts the watch", () => {
    observeHostClock(start)
    observeHostClock(start + 3_600_000)
    expect(hostResumedWithin(SUSPENSION_WINDOW_MS, start + 3_600_000)).toBe(false)
    expect(isHostSleepArtefact("Agent stalled: no activity for 600s", start + 3_600_000)).toBe(false)
  })

  it("records a wake when the wall clock runs ahead of the last tick and forgets it after the window", () => {
    stop = watchHostSuspension(start)
    observeHostClock(start + 5_000)
    expect(hostResumedWithin(SUSPENSION_WINDOW_MS, start + 10_000)).toBe(false)
    const woke = start + 10_000 + 3_600_000
    observeHostClock(woke)
    expect(hostResumedWithin(SUSPENSION_WINDOW_MS, woke + 30_000)).toBe(true)
    expect(hostResumedSince(start, woke + 30_000)).toBe(true)
    expect(hostResumedSince(woke + 1, woke + 30_000)).toBe(false)
    // Ticks keep arriving on time afterwards, so the window is measured from the wake itself.
    let at = woke + 30_000
    while (at < woke + SUSPENSION_WINDOW_MS + 5_000) {
      at += 5_000
      observeHostClock(at)
    }
    expect(hostResumedWithin(SUSPENSION_WINDOW_MS, at)).toBe(false)
  })

  it("notices a wake at the check itself, before the next tick fires", () => {
    stop = watchHostSuspension(start)
    expect(
      isHostSleepArtefact("Agent execution failed: Error: RPC timeout for thread/start (id=2).", start + 7_200_000),
    ).toBe(true)
  })

  it("attributes only transport and inactivity failures to the sleep", () => {
    stop = watchHostSuspension(start)
    const woke = start + 3_600_000
    observeHostClock(woke)
    for (const reason of [
      "Agent stalled: no activity for 600s",
      "Agent timed out after 7200s",
      "read ECONNRESET",
      "stream disconnected before completion",
    ])
      expect(isHostSleepArtefact(reason, woke + 30_000)).toBe(true)
    for (const reason of [
      "Task task-3 failed independent review: the fixture reports connection closed before the hook answers",
      "Contract command checks fail on the integrated tree: read ECONNRESET in tests/traffic_cli.rs",
      "cargo test failed",
    ])
      expect(isHostSleepArtefact(reason, woke + 30_000)).toBe(false)
  })

  it("waits until the host has stayed awake, through repeated short wakes", async () => {
    stop = watchHostSuspension(start)
    let at = start + 3_600_000
    observeHostClock(at)
    const waits: number[] = []
    // Two more sleeps of a quarter of an hour follow, each after ten seconds awake; then the lid opens.
    const naps = [900_000, 900_000]
    const waited = await hostStablyAwake(
      async (ms) => {
        waits.push(ms)
        at += ms
        if (waits.length % 2 === 0 && naps.length) at += naps.shift() as number
      },
      () => at,
    )
    expect(waited).toBe(true)
    expect(naps).toEqual([])
    // After the last wake the wait covers the whole stable interval.
    expect(waits.length * 5_000).toBeGreaterThanOrEqual(STABLE_WAKE_MS)
    expect(hostResumedWithin(STABLE_WAKE_MS, at)).toBe(false)
    expect(
      await hostStablyAwake(
        async () => {},
        () => at,
      ),
    ).toBe(false)
  })
})
