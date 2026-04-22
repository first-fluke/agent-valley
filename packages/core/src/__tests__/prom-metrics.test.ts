/**
 * Prometheus metrics tests — counter, histogram, gauge behaviour and
 * text-format rendering. Design ref: docs/plans/v0-2-bigbang-design.md § 5.8.
 */

import { describe, expect, test } from "vitest"
import { createNoopPromMetrics, createPromMetrics } from "../observability/prom-metrics"

describe("createPromMetrics (disabled / no-op)", () => {
  test("createPromMetrics defaults to disabled", () => {
    const m = createPromMetrics()
    expect(m.enabled).toBe(false)
  })

  test("createNoopPromMetrics returns a disabled instance", () => {
    expect(createNoopPromMetrics().enabled).toBe(false)
  })

  test("disabled instance accepts counter/histogram/gauge operations without throwing", () => {
    const m = createNoopPromMetrics()
    expect(() => {
      m.counter("foo", { a: "1" }).inc()
      m.counter("foo", { a: "1" }).inc(5)
      m.histogram("bar").observe(1.23)
      m.gauge("baz").set(42)
      m.gauge("baz").inc()
      m.gauge("baz").dec(3)
    }).not.toThrow()
  })

  test("disabled instance renders empty string", () => {
    const m = createNoopPromMetrics()
    m.counter("foo").inc()
    expect(m.render()).toBe("")
  })
})

describe("createPromMetrics (enabled)", () => {
  test("counter accumulates values and render outputs the metric line", () => {
    const m = createPromMetrics({ enabled: true })
    m.counter("av_dag_cycles_total").inc()
    m.counter("av_dag_cycles_total").inc(2)

    const text = m.render()
    expect(text).toContain("# TYPE av_dag_cycles_total counter")
    expect(text).toContain("av_dag_cycles_total 3")
  })

  test("counter with labels produces separate series", () => {
    const m = createPromMetrics({ enabled: true })
    m.counter("av_agent_runs_total", { agent: "claude", result: "success" }).inc()
    m.counter("av_agent_runs_total", { agent: "codex", result: "success" }).inc(2)

    const text = m.render()
    expect(text).toContain('av_agent_runs_total{agent="claude",result="success"} 1')
    expect(text).toContain('av_agent_runs_total{agent="codex",result="success"} 2')
  })

  test("gauge set / inc / dec updates the exposed value", () => {
    const m = createPromMetrics({ enabled: true })
    const g = m.gauge("av_retry_queue_size")
    g.set(3)
    g.inc()
    g.dec(2)

    const text = m.render()
    expect(text).toContain("# TYPE av_retry_queue_size gauge")
    expect(text).toContain("av_retry_queue_size 2")
  })

  test("histogram observe emits _bucket, _sum, _count series", () => {
    const m = createPromMetrics({ enabled: true })
    m.histogram("av_agent_duration_seconds", { agent: "claude" }).observe(0.2)
    m.histogram("av_agent_duration_seconds", { agent: "claude" }).observe(1.5)

    const text = m.render()
    expect(text).toContain("# TYPE av_agent_duration_seconds histogram")
    expect(text).toMatch(/av_agent_duration_seconds_bucket\{agent="claude",le="0\.25"\} 1/)
    expect(text).toMatch(/av_agent_duration_seconds_bucket\{agent="claude",le="2\.5"\} 2/)
    expect(text).toMatch(/av_agent_duration_seconds_bucket\{agent="claude",le="\+Inf"\} 2/)
    expect(text).toContain('av_agent_duration_seconds_sum{agent="claude"} 1.7')
    expect(text).toContain('av_agent_duration_seconds_count{agent="claude"} 2')
  })

  test("negative or non-finite values are ignored", () => {
    const m = createPromMetrics({ enabled: true })
    m.counter("foo").inc(-1)
    m.counter("foo").inc(Number.NaN)
    m.counter("foo").inc(Number.POSITIVE_INFINITY)
    const text = m.render()
    // No observations happened; HELP/TYPE header may appear only for
    // known names. "foo" is not known -> rendered value is 0.
    expect(text).toContain("foo 0")
  })

  test("label values containing quotes and backslashes are escaped", () => {
    const m = createPromMetrics({ enabled: true })
    m.counter("av_agent_runs_total", { agent: 'he said "hi"', result: "a\\b" }).inc()
    const text = m.render()
    expect(text).toContain('agent="he said \\"hi\\""')
    expect(text).toContain('result="a\\\\b"')
  })

  test("known metrics emit HELP and TYPE headers even without observations", () => {
    const m = createPromMetrics({ enabled: true })
    const text = m.render()
    expect(text).toContain("# HELP av_agent_runs_total")
    expect(text).toContain("# TYPE av_agent_runs_total counter")
    expect(text).toContain("# HELP av_retry_queue_size")
    expect(text).toContain("# TYPE av_retry_queue_size gauge")
  })
})
