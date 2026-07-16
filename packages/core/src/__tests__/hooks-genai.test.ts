/**
 * GenAI semantic-convention attribute mapping — verifies that agent token
 * usage is actually collected onto OTel spans as stable OTel GenAI semconv
 * (v1.43.0) attributes, so a GenAI-aware backend (Langfuse / Grafana / an
 * OTel Collector) can ingest per-run token telemetry. Guards the wiring the
 * completion handler relies on when it forwards `completedAttempt.tokenUsage`
 * into `onAgentDone`.
 */

import { describe, expect, it } from "vitest"
import { buildGenAiAttributes } from "../observability/hooks"

describe("buildGenAiAttributes — GenAI semconv collection", () => {
  it("maps token usage onto gen_ai.usage.* attributes", () => {
    const attrs = buildGenAiAttributes({
      agentType: "claude",
      issueKey: "ENG-1",
      issueId: "id-1",
      result: "success",
      tokenUsage: { input: 1200, output: 340, model: "claude-fable-5" },
    })

    expect(attrs["gen_ai.usage.input_tokens"]).toBe(1200)
    expect(attrs["gen_ai.usage.output_tokens"]).toBe(340)
    expect(attrs["gen_ai.request.model"]).toBe("claude-fable-5")
    expect(attrs["gen_ai.operation.name"]).toBe("invoke_agent")
  })

  it("maps internal agent type to the stable gen_ai.system provider value", () => {
    expect(
      buildGenAiAttributes({ agentType: "claude", issueKey: "k", issueId: "i", result: "success" })["gen_ai.system"],
    ).toBe("anthropic")
    expect(
      buildGenAiAttributes({ agentType: "codex", issueKey: "k", issueId: "i", result: "success" })["gen_ai.system"],
    ).toBe("openai")
    expect(
      buildGenAiAttributes({ agentType: "gemini", issueKey: "k", issueId: "i", result: "success" })["gen_ai.system"],
    ).toBe("gcp.gemini")
  })

  it("degrades gracefully for an unmapped agent type (no crash, raw value)", () => {
    const attrs = buildGenAiAttributes({ agentType: "future-agent", issueKey: "k", issueId: "i", result: "success" })
    expect(attrs["gen_ai.system"]).toBe("future-agent")
  })

  it("omits gen_ai.usage.* when no token usage was discovered (e.g. gemini CLI fallback)", () => {
    const attrs = buildGenAiAttributes({ agentType: "gemini", issueKey: "k", issueId: "i", result: "success" })
    expect(attrs["gen_ai.usage.input_tokens"]).toBeUndefined()
    expect(attrs["gen_ai.usage.output_tokens"]).toBeUndefined()
    expect(attrs["gen_ai.request.model"]).toBeUndefined()
  })
})
