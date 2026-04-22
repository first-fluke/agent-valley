/**
 * /api/metrics route tests — verify the route returns 404 when
 * Prometheus is disabled and Prometheus text (version=0.0.4) when
 * enabled.
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 3.1 (D), § 5.8, § 6.6 E24.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { PromMetrics } from "@agent-valley/core/observability/prom-metrics"
import { createPromMetrics } from "@agent-valley/core/observability/prom-metrics"

type EndpointConfig = {
  enabled: boolean
  path: string
  metrics: PromMetrics
} | null

let mockEndpoint: EndpointConfig = null

vi.mock("@/lib/metrics-singleton", () => ({
  getMetricsEndpoint: () => mockEndpoint,
  setMetricsEndpoint: (cfg: EndpointConfig) => {
    mockEndpoint = cfg
  },
}))

const { GET: metricsGET } = await import("@/app/api/metrics/route")

describe("GET /api/metrics", () => {
  beforeEach(() => {
    mockEndpoint = null
  })

  afterEach(() => {
    mockEndpoint = null
  })

  test("returns 404 when endpoint is not configured", async () => {
    const res = metricsGET()
    expect(res.status).toBe(404)
  })

  test("returns 404 when Prometheus is disabled", async () => {
    mockEndpoint = {
      enabled: false,
      path: "/api/metrics",
      metrics: createPromMetrics({ enabled: false }),
    }
    const res = metricsGET()
    expect(res.status).toBe(404)
  })

  test("returns 200 with Prometheus text format when enabled", async () => {
    const metrics = createPromMetrics({ enabled: true })
    metrics.counter("av_agent_runs_total", { agent: "claude", result: "success" }).inc()

    mockEndpoint = { enabled: true, path: "/api/metrics", metrics }
    const res = metricsGET()

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toMatch(/text\/plain; version=0\.0\.4/)
    const body = await res.text()
    expect(body).toContain('av_agent_runs_total{agent="claude",result="success"} 1')
    expect(body).toContain("# TYPE av_agent_runs_total counter")
  })

  test("returns 200 with empty body (not 500) when render throws", async () => {
    const throwingMetrics: PromMetrics = {
      enabled: true,
      counter: (() => ({ inc: () => {} })) as PromMetrics["counter"],
      histogram: () => ({ observe: () => {} }),
      gauge: () => ({ set: () => {}, inc: () => {}, dec: () => {} }),
      render: () => {
        throw new Error("internal render failure")
      },
    }
    mockEndpoint = { enabled: true, path: "/api/metrics", metrics: throwingMetrics }

    const res = metricsGET()
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toBe("")
  })
})
