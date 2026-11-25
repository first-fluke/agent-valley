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
    "You've hit your Fable limit · resets Nov 28 at 12pm (Australia/Sydney). Switch to another model to continue.",
    "rate_limit: You've hit your Opus 5.5 limit",
    "Quota exceeded for this account",
    "Subscription allowance depleted",
    "API error (status 402 Payment Required): Grok Build usage balance exhausted",
  ])("recognizes provider allowance exhaustion: %s", (reason) => {
    expect(classifyAgentExhaustion(reason)).toBe("usage")
  })

  test.each([
    "429 Too Many Requests",
    "429 Too many tokens per minute",
    "rate_limit_exceeded",
    "Rate limit reached for requests per minute",
    "You've hit your rate limit. Retry in 20 seconds.",
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
