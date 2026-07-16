/**
 * ObservabilityHooks <-> OtelExporter integration tests — verifies the
 * full pipe from an agent run's lifecycle hooks through to the actual
 * OTLP/HTTP JSON payload a real OTel Collector / GenAI-aware backend
 * would receive: one correlated trace across spawn -> completion with
 * proper parent/child spanId linkage, GenAI semantic-convention span
 * attributes + span naming, and the gen_ai.client.token.usage
 * histogram metric.
 *
 * Uses the real `createOtelExporter` (not a hand-rolled fake) with
 * fetch mocked, so these tests assert against the actual wire payload
 * rather than an internal call-recording shim.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createObservabilityHooks } from "../observability/hooks"
import { createOtelExporter } from "../observability/otel-exporter"

describe("ObservabilityHooks GenAI OTel pipeline", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 200 })) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  async function capturedSpans(fetchSpy: ReturnType<typeof vi.fn>): Promise<Array<Record<string, unknown>>> {
    const calls = fetchSpy.mock.calls.filter((c) => c[0] === "http://localhost:4318/v1/traces")
    const call = calls.at(-1)
    if (!call) return []
    const body = JSON.parse((call[1] as RequestInit).body as string)
    return body.resourceSpans[0].scopeSpans[0].spans
  }

  async function capturedMetrics(fetchSpy: ReturnType<typeof vi.fn>): Promise<Array<Record<string, unknown>>> {
    const calls = fetchSpy.mock.calls.filter((c) => c[0] === "http://localhost:4318/v1/metrics")
    const call = calls.at(-1)
    if (!call) return []
    const body = JSON.parse((call[1] as RequestInit).body as string)
    return body.resourceMetrics[0].scopeMetrics[0].metrics
  }

  test("onAgentStart -> onAgentDone emits two spans under one traceId with parent/child linkage and gen_ai.* attributes", async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const otel = createOtelExporter({
      enabled: true,
      endpoint: "http://localhost:4318",
      serviceName: "agent-valley-test",
    })
    const hooks = createObservabilityHooks({ otel })
    try {
      hooks.onAgentStart({ agentType: "claude", issueKey: "PROJ-1", issueId: "i1", attemptId: "att-1" })
      hooks.onAgentDone({
        agentType: "claude",
        issueKey: "PROJ-1",
        issueId: "i1",
        attemptId: "att-1",
        durationMs: 1_000,
        tokenUsage: { input: 100, output: 50, model: "claude-sonnet-4.5" },
      })
      await otel.flush()

      const spans = await capturedSpans(fetchSpy)
      expect(spans).toHaveLength(2)

      const spawn = spans.find((s) => s.name === "invoke_agent")
      const run = spans.find((s) => s.name === "invoke_agent claude-sonnet-4.5")
      expect(spawn).toBeDefined()
      expect(run).toBeDefined()

      // One correlated trace, proper parent/child linkage.
      expect(spawn?.traceId).toBe(run?.traceId)
      expect(spawn?.traceId).toMatch(/^[0-9a-f]{32}$/)
      expect(spawn?.parentSpanId).toBeUndefined()
      expect(run?.parentSpanId).toBe(spawn?.spanId)

      // CLIENT span kind per GenAI semconv.
      expect(spawn?.kind).toBe(3)
      expect(run?.kind).toBe(3)

      const runAttrs = run?.attributes as Array<{ key: string; value: Record<string, unknown> }>
      expect(runAttrs).toContainEqual({ key: "gen_ai.operation.name", value: { stringValue: "invoke_agent" } })
      expect(runAttrs).toContainEqual({ key: "gen_ai.system", value: { stringValue: "anthropic" } })
      expect(runAttrs).toContainEqual({ key: "gen_ai.request.model", value: { stringValue: "claude-sonnet-4.5" } })
      expect(runAttrs).toContainEqual({ key: "gen_ai.usage.input_tokens", value: { intValue: "100" } })
      expect(runAttrs).toContainEqual({ key: "gen_ai.usage.output_tokens", value: { intValue: "50" } })

      const spawnAttrs = spawn?.attributes as Array<{ key: string; value: Record<string, unknown> }>
      expect(spawnAttrs).toContainEqual({ key: "gen_ai.operation.name", value: { stringValue: "invoke_agent" } })
      expect(spawnAttrs).toContainEqual({ key: "gen_ai.system", value: { stringValue: "anthropic" } })
    } finally {
      await otel.shutdown()
    }
  })

  test("onAgentDone with tokenUsage emits the gen_ai.client.token.usage histogram for both input and output", async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const otel = createOtelExporter({ enabled: true, endpoint: "http://localhost:4318", serviceName: "x" })
    const hooks = createObservabilityHooks({ otel })
    try {
      hooks.onAgentStart({ agentType: "codex", issueKey: "PROJ-2", issueId: "i2", attemptId: "att-2" })
      hooks.onAgentDone({
        agentType: "codex",
        issueKey: "PROJ-2",
        issueId: "i2",
        attemptId: "att-2",
        durationMs: 500,
        tokenUsage: { input: 200, output: 75, model: "gpt-5-codex" },
      })
      await otel.flush()

      const metrics = await capturedMetrics(fetchSpy)
      const histograms = metrics.filter((m) => m.name === "gen_ai.client.token.usage")
      expect(histograms).toHaveLength(2)

      const inputPoint = (histograms[0] as { histogram: { dataPoints: Array<Record<string, unknown>> } }).histogram
        .dataPoints[0] as Record<string, unknown>
      const inputAttrs = inputPoint.attributes as Array<{ key: string; value: Record<string, unknown> }>
      const outputPoint = (histograms[1] as { histogram: { dataPoints: Array<Record<string, unknown>> } }).histogram
        .dataPoints[0] as Record<string, unknown>
      const outputAttrs = outputPoint.attributes as Array<{ key: string; value: Record<string, unknown> }>

      expect(inputAttrs).toContainEqual({ key: "gen_ai.token.type", value: { stringValue: "input" } })
      expect(inputAttrs).toContainEqual({ key: "gen_ai.system", value: { stringValue: "openai" } })
      expect(inputPoint.sum).toBe(200)

      expect(outputAttrs).toContainEqual({ key: "gen_ai.token.type", value: { stringValue: "output" } })
      expect(outputPoint.sum).toBe(75)
    } finally {
      await otel.shutdown()
    }
  })

  test("onAgentDone without tokenUsage emits no gen_ai.client.token.usage histogram", async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const otel = createOtelExporter({ enabled: true, endpoint: "http://localhost:4318", serviceName: "x" })
    const hooks = createObservabilityHooks({ otel })
    try {
      hooks.onAgentStart({ agentType: "gemini", issueKey: "PROJ-3", issueId: "i3", attemptId: "att-3" })
      hooks.onAgentDone({ agentType: "gemini", issueKey: "PROJ-3", issueId: "i3", attemptId: "att-3", durationMs: 300 })
      await otel.flush()

      const metrics = await capturedMetrics(fetchSpy)
      expect(metrics.filter((m) => m.name === "gen_ai.client.token.usage")).toHaveLength(0)

      const spans = await capturedSpans(fetchSpy)
      const run = spans.find((s) => s.name === "invoke_agent") // no model -> no suffix
      const runAttrs = run?.attributes as Array<{ key: string; value: Record<string, unknown> }>
      expect(runAttrs).toContainEqual({ key: "gen_ai.system", value: { stringValue: "gcp.gemini" } })
    } finally {
      await otel.shutdown()
    }
  })

  test("onAgentFailed also correlates to the spawn span's trace and carries GenAI attributes", async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const otel = createOtelExporter({ enabled: true, endpoint: "http://localhost:4318", serviceName: "x" })
    const hooks = createObservabilityHooks({ otel })
    try {
      hooks.onAgentStart({ agentType: "claude", issueKey: "PROJ-4", issueId: "i4", attemptId: "att-4" })
      hooks.onAgentFailed({
        agentType: "claude",
        issueKey: "PROJ-4",
        issueId: "i4",
        attemptId: "att-4",
        durationMs: 200,
        retryable: false,
      })
      await otel.flush()

      const spans = await capturedSpans(fetchSpy)
      const spawn = spans.find((s) => s.name === "invoke_agent")
      const failed = spans.find((s) => s.status && (s.status as Record<string, unknown>).code === 2)
      expect(failed?.traceId).toBe(spawn?.traceId)
      expect(failed?.parentSpanId).toBe(spawn?.spanId)

      const failedAttrs = failed?.attributes as Array<{ key: string; value: Record<string, unknown> }>
      expect(failedAttrs).toContainEqual({ key: "result", value: { stringValue: "failure" } })
    } finally {
      await otel.shutdown()
    }
  })

  test("an unmapped future agentType falls back to the raw string for gen_ai.system instead of throwing", async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const otel = createOtelExporter({ enabled: true, endpoint: "http://localhost:4318", serviceName: "x" })
    const hooks = createObservabilityHooks({ otel })
    try {
      expect(() =>
        hooks.onAgentStart({ agentType: "future-agent", issueKey: "PROJ-5", issueId: "i5", attemptId: "att-5" }),
      ).not.toThrow()
      await otel.flush()

      const spans = await capturedSpans(fetchSpy)
      const attrs = spans[0]?.attributes as Array<{ key: string; value: Record<string, unknown> }>
      expect(attrs).toContainEqual({ key: "gen_ai.system", value: { stringValue: "future-agent" } })
    } finally {
      await otel.shutdown()
    }
  })
})
