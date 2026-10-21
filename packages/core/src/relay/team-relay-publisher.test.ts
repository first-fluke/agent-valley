import { afterEach, describe, expect, it, vi } from "vitest"
import { logger } from "../observability/logger"
import type { PublishableEvent } from "./team-event-codec"
import { TeamRelayError } from "./team-relay-error"
import { TeamRelayPublisher } from "./team-relay-publisher"

const join: PublishableEvent = {
  type: "node.join",
  nodeId: "11111111-1111-4111-8111-111111111111:laptop",
  clientTimestamp: "2026-10-21T00:00:00.000Z",
  payload: { defaultAgentType: "codex", maxParallel: 2, displayName: "Alice" },
}
const start: PublishableEvent = {
  ...join,
  type: "agent.start",
  payload: { agentType: "codex", issueKey: "AV-1", issueId: "issue-1" },
}

describe("TeamRelayPublisher", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
  it("retains failed heads ahead of later events and reuses IDs for exact retries", async () => {
    vi.useFakeTimers()
    const publish = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined)
    const publisher = new TeamRelayPublisher({ publish })
    await publisher.publish(join)
    await publisher.publish(start)
    expect(publish.mock.calls.map((args) => args[0].type)).toEqual(["node.join", "node.join"])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(publish.mock.calls.map((args) => args[0].type)).toEqual([
      "node.join",
      "node.join",
      "node.join",
      "agent.start",
    ])
    expect(new Set(publish.mock.calls.slice(0, 3).map((args) => args[1])).size).toBe(1)
    expect(publish.mock.calls[3]?.[1]).not.toBe(publish.mock.calls[0]?.[1])
    await publisher.dispose()
  })

  it("joins in-flight work and flushes queued events before shutdown returns", async () => {
    let release: () => void = () => undefined
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const publish = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(undefined)
    const publisher = new TeamRelayPublisher({ publish })
    const first = publisher.publish(join)
    const second = publisher.publish(start)
    let disposed = false
    const shutdown = publisher.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release()
    await Promise.all([first, second, shutdown])
    expect(publish).toHaveBeenCalledTimes(2)
    await expect(publisher.publish(join)).rejects.toMatchObject({ code: "publisher_closed" })
    await publisher.dispose()
  })

  it("bounds retries, redacts errors and drops permanent failures without retrying", async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined)
    const publish = vi.fn().mockRejectedValue(new Error("secret-user-token"))
    const publisher = new TeamRelayPublisher({ publish })
    await publisher.publish(join)
    await vi.advanceTimersByTimeAsync(50_000)
    expect(publish).toHaveBeenCalledTimes(5)
    await publisher.dispose()
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-user-token")
    const rejected = vi.fn().mockRejectedValue(new TeamRelayError("session_invalid", "secret", 401))
    const permanent = new TeamRelayPublisher({ publish: rejected })
    await permanent.publish(join)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(rejected).toHaveBeenCalledOnce()
    await permanent.dispose()
  })

  it("does a final bounded flush when stopping offline and rejects invalid events before dispatch", async () => {
    const publish = vi.fn().mockRejectedValue(new Error("offline"))
    const publisher = new TeamRelayPublisher({ publish })
    await expect(publisher.publish({ ...join, nodeId: "" })).rejects.toMatchObject({ code: "invalid_event" })
    expect(publish).not.toHaveBeenCalled()
    await publisher.publish(join)
    await publisher.dispose()
    expect(publish).toHaveBeenCalledTimes(2)
  })
})
