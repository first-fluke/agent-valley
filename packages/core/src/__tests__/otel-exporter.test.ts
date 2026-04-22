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
