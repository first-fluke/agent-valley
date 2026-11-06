import { describe, expect, test } from "vitest"
import { classifyAgentExhaustion } from "../domain/agent-exhaustion"

describe("classifyAgentExhaustion", () => {
  test.each([
    "context_length_exceeded",
    "contextWindowExceeded",
    "Your input exceeds the context window limit of this model.",
    "This model's maximum context length is 200000 tokens.",
    "Prompt is too long",
    "Too many input tokens",
    "Token budget exhausted",
  ])("recognizes context exhaustion: %s", (reason) => {
    expect(classifyAgentExhaustion(reason)).toBe("context")
  })

  test.each([
    "usage_limit_reached",
    "usageLimitExceeded",
    "insufficient_quota",
    "Insufficient credits for this request",
    "Your credit balance is too low to access the API.",
    "You are out of credits",
    "You've hit your usage limit. Try again later.",
    "You've hit your limit · resets 5pm",
    "Quota exceeded for this account",
    "Subscription allowance depleted",
  ])("recognizes provider allowance exhaustion: %s", (reason) => {
    expect(classifyAgentExhaustion(reason)).toBe("usage")
  })

  test.each([
    "429 Too Many Requests",
    "429 Too many tokens per minute",
    "rate_limit_exceeded",
    "Rate limit reached for requests per minute",
    "Invalid API token",
    "Expired token; log in again",
    "error_max_turns: Reached max turns",
    "error_max_budget_usd: task budget exceeded",
    "Mission Actor call limit reached",
    "Configured-price estimated cost limit reached",
    "Token usage updated: 200000",
    "Unexpected error",
    "",
  ])("does not hand off unrelated failures: %s", (reason) => {
    expect(classifyAgentExhaustion(reason)).toBeUndefined()
  })
})
