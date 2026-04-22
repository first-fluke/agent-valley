/**
 * GET /api/metrics — Prometheus text exposition endpoint.
 *
 * Returns 200 with Prometheus text (version=0.0.4) when
 * `observability.prometheus.enabled === true`, otherwise 404.
 *
 * Reference:
 *   docs/plans/v0-2-bigbang-design.md § 3.1 (D), § 5.8
 *   https://prometheus.io/docs/instrumenting/exposition_formats/
 */

import { getMetricsEndpoint } from "@/lib/metrics-singleton"

export function GET(): Response {
  const endpoint = getMetricsEndpoint()
  if (!endpoint || !endpoint.enabled) {
    return new Response("Not found", { status: 404 })
  }

  let body: string
  try {
    body = endpoint.metrics.render()
  } catch {
    // Per § 6.6 E24: do not return 500. Emit empty output and bump the
    // internal error counter. The counter is part of the same metrics
    // instance so the next scrape will surface the failure.
    try {
      endpoint.metrics.counter("av_observability_errors_total", { exporter: "prometheus" }).inc()
    } catch {
      /* truly give up */
    }
    body = ""
  }

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      // Prometheus scrape responses are short-lived by design.
      "cache-control": "no-store",
    },
  })
}
