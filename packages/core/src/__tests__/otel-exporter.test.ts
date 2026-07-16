/**
 * OTel exporter tests — no-op when disabled, OTLP/HTTP POST when
 * enabled, and silent-swallow on network failure with self-counter
 * increment.
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 5.8, § 6.6 E23.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createNoopOtelExporter, createOtelExporter } from "../observability/otel-exporter"
import { createPromMetrics } from "../observability/prom-metrics"

describe("createOtelExporter (disabled)", () => {
  test("enabled:false returns a no-op exporter", async () => {
    const exp = createOtelExporter({ enabled: false, endpoint: "http://localhost:4318", serviceName: "x" })
    expect(exp.enabled).toBe(false)
    exp.recordSpan({ name: "s", startTimeMs: 1, endTimeMs: 2 })
    exp.recordCounter("c", 1)
    exp.recordHistogram("h", 1)
    await exp.flush()
    await exp.shutdown()
  })

  test("createNoopOtelExporter returns disabled instance", () => {
    expect(createNoopOtelExporter().enabled).toBe(false)
  })

  test("malformed endpoint falls back to no-op", () => {
    const exp = createOtelExporter({ enabled: true, endpoint: "not-a-url", serviceName: "x" })
    expect(exp.enabled).toBe(false)
  })
})

describe("createOtelExporter (enabled)", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    // Default mock: succeed with 200 OK
    globalThis.fetch = vi.fn(async () => new Response("", { status: 200 })) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
  })

  test("flush POSTs spans to /v1/traces with OTLP-shaped JSON", async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const exp = createOtelExporter({
      enabled: true,
      endpoint: "http://localhost:4318",
      serviceName: "agent-valley-test",
    })
    try {
      exp.recordSpan({
        name: "agent.run",
        startTimeMs: 1_000,
        endTimeMs: 2_500,
        status: "ok",
        attributes: { agent: "claude", result: "success" },
      })
      await exp.flush()

      expect(fetchSpy).toHaveBeenCalled()
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe("http://localhost:4318/v1/traces")
      expect(init.method).toBe("POST")
      const body = JSON.parse(init.body as string)
      expect(body.resourceSpans[0].scopeSpans[0].spans[0].name).toBe("agent.run")
      expect(body.resourceSpans[0].resource.attributes[0].value.stringValue).toBe("agent-valley-test")
    } finally {
      await exp.shutdown()
    }
  })

  test("flush POSTs counters to /v1/metrics", async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const exp = createOtelExporter({
      enabled: true,
      endpoint: "http://localhost:4318/",
      serviceName: "x",
    })
    try {
      exp.recordCounter("av_agent_runs_total", 1, { agent: "claude", result: "success" })
      await exp.flush()

      const urls = fetchSpy.mock.calls.map((c) => c[0] as string)
      expect(urls).toContain("http://localhost:4318/v1/metrics")
      const metricsCall = fetchSpy.mock.calls.find((c) => c[0] === "http://localhost:4318/v1/metrics")
      expect(metricsCall).toBeDefined()
      const body = JSON.parse((metricsCall?.[1] as RequestInit).body as string)
      expect(body.resourceMetrics[0].scopeMetrics[0].metrics[0].name).toBe("av_agent_runs_total")
    } finally {
      await exp.shutdown()
    }
  })

  test("network failure is swallowed and bumps av_observability_errors_total", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("connection refused")
    }) as unknown as typeof fetch

    const metrics = createPromMetrics({ enabled: true })
    const exp = createOtelExporter({
      enabled: true,
      endpoint: "http://localhost:4318",
      serviceName: "x",
      metrics,
    })
    try {
      exp.recordSpan({ name: "x", startTimeMs: 1, endTimeMs: 2 })
      await expect(exp.flush()).resolves.toBeUndefined()

      const text = metrics.render()
      expect(text).toContain('av_observability_errors_total{exporter="otel"} 1')
    } finally {
      await exp.shutdown()
    }
  })

  test("non-2xx response is recorded as an error", async () => {
    globalThis.fetch = vi.fn(async () => new Response("bad", { status: 500 })) as unknown as typeof fetch

    const metrics = createPromMetrics({ enabled: true })
    const exp = createOtelExporter({
      enabled: true,
      endpoint: "http://localhost:4318",
      serviceName: "x",
      metrics,
    })
    try {
      exp.recordCounter("foo", 1)
      await exp.flush()
      const text = metrics.render()
      expect(text).toContain('av_observability_errors_total{exporter="otel"} 1')
    } finally {
      await exp.shutdown()
    }
  })

  test("shutdown drains buffered spans", async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const exp = createOtelExporter({ enabled: true, endpoint: "http://localhost:4318", serviceName: "x" })
    exp.recordSpan({ name: "drain-me", startTimeMs: 1, endTimeMs: 2 })
    await exp.shutdown()
    expect(fetchSpy).toHaveBeenCalled()
  })
})

describe("createOtelExporter — trace correlation (runId)", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 200 })) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
  })

  /** Returns the spans from the *most recent* POST to /v1/traces (important when a test flushes multiple times). */
  async function capturedSpans(fetchSpy: ReturnType<typeof vi.fn>): Promise<Array<Record<string, unknown>>> {
    const calls = fetchSpy.mock.calls.filter((c) => c[0] === "http://localhost:4318/v1/traces")
    const call = calls.at(-1)
    if (!call) return []
    const body = JSON.parse((call[1] as RequestInit).body as string)
    return body.resourceSpans[0].scopeSpans[0].spans
  }

  test("two spans without a runId get independent traceIds (pre-existing behavior preserved)", async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const exp = createOtelExporter({ enabled: true, endpoint: "http://localhost:4318", serviceName: "x" })
    try {
      exp.recordSpan({ name: "a", startTimeMs: 1, endTimeMs: 2 })
      exp.recordSpan({ name: "b", startTimeMs: 1, endTimeMs: 2 })
      await exp.flush()

      const spans = await capturedSpans(fetchSpy)
      expect(spans).toHaveLength(2)
      expect(spans[0]?.traceId).not.toBe(spans[1]?.traceId)
      expect(spans[0]?.parentSpanId).toBeUndefined()
      expect(spans[1]?.parentSpanId).toBeUndefined()
    } finally {
      await exp.shutdown()
    }
  })

  test("spans sharing a runId are emitted under one traceId with parent/child spanId linkage", async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const exp = createOtelExporter({ enabled: true, endpoint: "http://localhost:4318", serviceName: "x" })
    try {
      exp.recordSpan({ name: "agent.spawn", startTimeMs: 1, endTimeMs: 1, runId: "attempt-1" })
      exp.recordSpan({ name: "agent.run", startTimeMs: 2, endTimeMs: 3, runId: "attempt-1", terminal: true })
      await exp.flush()

      const spans = await capturedSpans(fetchSpy)
      expect(spans).toHaveLength(2)
      const spawn = spans.find((s) => s.name === "agent.spawn")
      const run = spans.find((s) => s.name === "agent.run")
      expect(spawn?.traceId).toBeTruthy()
      expect(spawn?.traceId).toBe(run?.traceId)
      expect(spawn?.parentSpanId).toBeUndefined()
      expect(run?.parentSpanId).toBe(spawn?.spanId)
    } finally {
      await exp.shutdown()
    }
  })

  test("a different runId never inherits another run's trace/span linkage", async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const exp = createOtelExporter({ enabled: true, endpoint: "http://localhost:4318", serviceName: "x" })
    try {
      exp.recordSpan({ name: "agent.spawn", startTimeMs: 1, endTimeMs: 1, runId: "attempt-1" })
      await exp.flush()
      const attempt1Spans = await capturedSpans(fetchSpy)

      // A concurrent, unrelated attempt with a different runId must not
      // pick up attempt-1's trace/span linkage.
      exp.recordSpan({ name: "agent.spawn", startTimeMs: 3, endTimeMs: 3, runId: "attempt-2" })
      await exp.flush()
      const attempt2Spans = await capturedSpans(fetchSpy)

      expect(attempt2Spans[0]?.traceId).not.toBe(attempt1Spans[0]?.traceId)
      expect(attempt2Spans[0]?.parentSpanId).toBeUndefined()
    } finally {
      await exp.shutdown()
    }
  })

  test("spans across separate flush() batches for the same runId still correlate (ids resolved at record time)", async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const exp = createOtelExporter({ enabled: true, endpoint: "http://localhost:4318", serviceName: "x" })
    try {
      exp.recordSpan({ name: "agent.spawn", startTimeMs: 1, endTimeMs: 1, runId: "attempt-batch" })
      await exp.flush()
      const firstBatchSpans = await capturedSpans(fetchSpy)
      const spawnSpanId = firstBatchSpans[0]?.spanId

      exp.recordSpan({ name: "agent.run", startTimeMs: 2, endTimeMs: 3, runId: "attempt-batch", terminal: true })
      await exp.flush()
      const secondBatchSpans = await capturedSpans(fetchSpy)

      expect(secondBatchSpans[0]?.traceId).toBe(firstBatchSpans[0]?.traceId)
      expect(secondBatchSpans[0]?.parentSpanId).toBe(spawnSpanId)
    } finally {
      await exp.shutdown()
    }
  })

  test("terminal span releases the runId link — a later span with the same runId starts a new trace", async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const exp = createOtelExporter({ enabled: true, endpoint: "http://localhost:4318", serviceName: "x" })
    try {
      exp.recordSpan({ name: "agent.run", startTimeMs: 1, endTimeMs: 2, runId: "reused-id", terminal: true })
      await exp.flush()
      const firstSpans = await capturedSpans(fetchSpy)

      // A later, unrelated run happens to reuse the same attemptId string
      // (e.g. a retried attempt id collision) — since the first run was
      // terminal, this must NOT be treated as a child span.
      exp.recordSpan({ name: "agent.run", startTimeMs: 10, endTimeMs: 11, runId: "reused-id", terminal: true })
      await exp.flush()
      const secondSpans = await capturedSpans(fetchSpy)

      expect(secondSpans[0]?.traceId).not.toBe(firstSpans[0]?.traceId)
      expect(secondSpans[0]?.parentSpanId).toBeUndefined()
    } finally {
      await exp.shutdown()
    }
  })
})

describe("createOtelExporter — OTLP wire-shape validity", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 200 })) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
  })

  test("span traceId/spanId are valid lowercase hex of the correct byte length (16/8 bytes)", async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const exp = createOtelExporter({ enabled: true, endpoint: "http://localhost:4318", serviceName: "x" })
    try {
      exp.recordSpan({ name: "invoke_agent", startTimeMs: 1, endTimeMs: 2, kind: 3 })
      await exp.flush()

      const call = fetchSpy.mock.calls.find((c) => c[0] === "http://localhost:4318/v1/traces")
      const body = JSON.parse((call?.[1] as RequestInit).body as string)
      const span = body.resourceSpans[0].scopeSpans[0].spans[0]

      // 16-byte traceId -> 32 hex chars; 8-byte spanId -> 16 hex chars.
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/)
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/)
      expect(span.kind).toBe(3)
      // Nanosecond timestamps must be strings (avoids JS number precision loss on int64).
      expect(typeof span.startTimeUnixNano).toBe("string")
      expect(typeof span.endTimeUnixNano).toBe("string")
      expect(span.status).toEqual({ code: 1 })
    } finally {
      await exp.shutdown()
    }
  })

  test("span attributes are encoded as OTLP AnyValue key/value pairs", async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const exp = createOtelExporter({ enabled: true, endpoint: "http://localhost:4318", serviceName: "x" })
    try {
      exp.recordSpan({
        name: "invoke_agent",
        startTimeMs: 1,
        endTimeMs: 2,
        attributes: { "gen_ai.system": "anthropic", "gen_ai.usage.input_tokens": 100, ok: true },
      })
      await exp.flush()

      const call = fetchSpy.mock.calls.find((c) => c[0] === "http://localhost:4318/v1/traces")
      const body = JSON.parse((call?.[1] as RequestInit).body as string)
      const attrs: Array<{ key: string; value: Record<string, unknown> }> =
        body.resourceSpans[0].scopeSpans[0].spans[0].attributes

      expect(attrs).toContainEqual({ key: "gen_ai.system", value: { stringValue: "anthropic" } })
      expect(attrs).toContainEqual({ key: "gen_ai.usage.input_tokens", value: { intValue: "100" } })
      expect(attrs).toContainEqual({ key: "ok", value: { boolValue: true } })
    } finally {
      await exp.shutdown()
    }
  })

  test("resource carries service.name as a string AnyValue", async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const exp = createOtelExporter({
      enabled: true,
      endpoint: "http://localhost:4318",
      serviceName: "agent-valley-test",
    })
    try {
      exp.recordSpan({ name: "invoke_agent", startTimeMs: 1, endTimeMs: 2 })
      await exp.flush()

      const call = fetchSpy.mock.calls.find((c) => c[0] === "http://localhost:4318/v1/traces")
      const body = JSON.parse((call?.[1] as RequestInit).body as string)
      expect(body.resourceSpans[0].resource.attributes).toContainEqual({
        key: "service.name",
        value: { stringValue: "agent-valley-test" },
      })
    } finally {
      await exp.shutdown()
    }
  })
})

describe("createOtelExporter — GenAI token-usage histogram", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 200 })) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
  })

  test("recordHistogram POSTs a valid OTLP Histogram metric to /v1/metrics", async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const exp = createOtelExporter({ enabled: true, endpoint: "http://localhost:4318", serviceName: "x" })
    try {
      exp.recordHistogram("gen_ai.client.token.usage", 1234, {
        "gen_ai.system": "anthropic",
        "gen_ai.token.type": "input",
      })
      await exp.flush()

      const call = fetchSpy.mock.calls.find((c) => c[0] === "http://localhost:4318/v1/metrics")
      expect(call).toBeDefined()
      const body = JSON.parse((call?.[1] as RequestInit).body as string)
      const metric = body.resourceMetrics[0].scopeMetrics[0].metrics.find(
        (m: { name: string }) => m.name === "gen_ai.client.token.usage",
      )
      expect(metric).toBeDefined()
      expect(metric.histogram.aggregationTemporality).toBe(1)
      const point = metric.histogram.dataPoints[0]
      expect(point.count).toBe("1")
      expect(point.sum).toBe(1234)
      expect(point.bucketCounts).toEqual(["1"])
      expect(point.explicitBounds).toEqual([])
      expect(point.attributes).toContainEqual({ key: "gen_ai.token.type", value: { stringValue: "input" } })
    } finally {
      await exp.shutdown()
    }
  })

  test("counters and histograms in the same flush both appear in the metrics payload", async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const exp = createOtelExporter({ enabled: true, endpoint: "http://localhost:4318", serviceName: "x" })
    try {
      exp.recordCounter("av_agent_runs_total", 1, { result: "success" })
      exp.recordHistogram("gen_ai.client.token.usage", 500, { "gen_ai.token.type": "output" })
      await exp.flush()

      const call = fetchSpy.mock.calls.find((c) => c[0] === "http://localhost:4318/v1/metrics")
      const body = JSON.parse((call?.[1] as RequestInit).body as string)
      const names = body.resourceMetrics[0].scopeMetrics[0].metrics.map((m: { name: string }) => m.name)
      expect(names).toContain("av_agent_runs_total")
      expect(names).toContain("gen_ai.client.token.usage")
    } finally {
      await exp.shutdown()
    }
  })
})

describe("createOtelExporter — env var fallback", () => {
  const originalFetch = globalThis.fetch
  const originalEndpointEnv = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  const originalServiceNameEnv = process.env.OTEL_SERVICE_NAME

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 200 })) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
    if (originalEndpointEnv === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEndpointEnv
    if (originalServiceNameEnv === undefined) delete process.env.OTEL_SERVICE_NAME
    else process.env.OTEL_SERVICE_NAME = originalServiceNameEnv
  })

  test("falls back to OTEL_EXPORTER_OTLP_ENDPOINT when cfg.endpoint is empty", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector.internal:4318"
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const exp = createOtelExporter({ enabled: true, endpoint: "", serviceName: "x" })
    try {
      expect(exp.enabled).toBe(true)
      exp.recordSpan({ name: "invoke_agent", startTimeMs: 1, endTimeMs: 2 })
      await exp.flush()
      expect(fetchSpy).toHaveBeenCalledWith("http://collector.internal:4318/v1/traces", expect.anything())
    } finally {
      await exp.shutdown()
    }
  })

  test("cfg.endpoint from valley.yaml wins over the env var when both are set", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://ignored:4318"
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const exp = createOtelExporter({ enabled: true, endpoint: "http://configured:4318", serviceName: "x" })
    try {
      exp.recordSpan({ name: "invoke_agent", startTimeMs: 1, endTimeMs: 2 })
      await exp.flush()
      expect(fetchSpy).toHaveBeenCalledWith("http://configured:4318/v1/traces", expect.anything())
    } finally {
      await exp.shutdown()
    }
  })

  test("falls back to OTEL_SERVICE_NAME, then 'agent-valley', when cfg.serviceName is empty", async () => {
    delete process.env.OTEL_SERVICE_NAME
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const exp = createOtelExporter({ enabled: true, endpoint: "http://localhost:4318", serviceName: "" })
    try {
      exp.recordSpan({ name: "invoke_agent", startTimeMs: 1, endTimeMs: 2 })
      await exp.flush()
      const call = fetchSpy.mock.calls.find((c) => c[0] === "http://localhost:4318/v1/traces")
      const body = JSON.parse((call?.[1] as RequestInit).body as string)
      expect(body.resourceSpans[0].resource.attributes).toContainEqual({
        key: "service.name",
        value: { stringValue: "agent-valley" },
      })
    } finally {
      await exp.shutdown()
    }
  })

  test("still fails soft to a no-op exporter when neither cfg.endpoint nor the env var is set", () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    const exp = createOtelExporter({ enabled: true, endpoint: "", serviceName: "x" })
    expect(exp.enabled).toBe(false)
  })
})
