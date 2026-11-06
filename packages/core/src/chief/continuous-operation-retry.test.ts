import { expect, it, vi } from "vitest"
import { runContinuousOperation } from "./continuous-operation"
import { baseline, fixture, operation } from "./continuous-operation.fixture"

it("consumes an explicit selection retry once and retains spent automatic attempts", async () => {
  const { record, ports, saved } = fixture(
    operation({
      phase: "paused",
      baseline: baseline(),
      decisionId: "exhausted-decision",
      recovery: {
        target: "decision",
        checkpointId: "exhausted-decision",
        attempts: 3,
        disposition: "protected",
        reason: "Invalid Chief decision",
      },
    }),
  )
  ports.retryDecision = true
  ports.decide = vi.fn(async () => {
    throw new Error("Invalid Chief decision: still invalid")
  })
  await runContinuousOperation(record, ports)
  expect(ports.decide).toHaveBeenCalledOnce()
  expect(record.recovery?.attempts).toBe(4)
  expect(saved.some((entry) => entry.recovery?.attempts === 4 && entry.recovery.disposition === "retrying")).toBe(true)
  ports.retryDecision = false
  await runContinuousOperation(record, ports)
  expect(ports.decide).toHaveBeenCalledOnce()
  expect(record.recovery?.attempts).toBe(4)
})
