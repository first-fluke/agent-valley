import { PassThrough } from "node:stream"
import { describe, expect, test } from "vitest"
import { classifyAgentExhaustion } from "../domain/agent-exhaustion"
import { captureExhaustion, nativeErrorMessage } from "./native-failure"

describe("native failure details", () => {
  test("preserves nested provider error types without arbitrary event payloads", () => {
    const message = nativeErrorMessage(
      {
        type: "result",
        error: { type: "insufficient_quota", message: "The request failed" },
        credentials: "private-value",
        unrelated: { message: "private-value" },
      },
      "fallback",
    )
    expect(classifyAgentExhaustion(message)).toBe("usage")
    expect(message).toContain("The request failed")
    expect(message).not.toContain("private-value")
  })

  test("limits the amount of structured error text retained", () => {
    const message = nativeErrorMessage(
      { errors: Array.from({ length: 50 }, (_, index) => `${index}:${"x".repeat(50_000)}`) },
      "fallback",
    )
    expect(message.length).toBeLessThanOrEqual(10_240)
    expect(nativeErrorMessage(undefined, "fallback")).toBe("fallback")
  })

  test("latches split stderr exhaustion while keeping raw stderr private", () => {
    const stream = new PassThrough()
    const failure = captureExhaustion(stream)
    stream.write("private-value\ninsufficient_")
    stream.write("quota\n")
    stream.write("a".repeat(10_000))
    const message = failure() ?? ""
    expect(classifyAgentExhaustion(message)).toBe("usage")
    expect(message).not.toContain("private-value")
    stream.end()
  })

  test("does not turn ordinary throttling or unrelated stderr into exhaustion", () => {
    const stream = new PassThrough()
    const failure = captureExhaustion(stream)
    stream.write("429 Too Many Requests\nprivate-value\nInvalid token\n")
    expect(failure()).toBeUndefined()
    stream.end()
  })
})
