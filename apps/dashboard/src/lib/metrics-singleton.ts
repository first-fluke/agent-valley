/**
 * Prometheus metrics singleton — bootstrap wires it up once, Route
 * Handlers read it. Follows the same globalThis pattern as
 * orchestrator-singleton.ts (Turbopack bundling may instantiate
 * modules per-route).
 *
 * When Prometheus is disabled in valley.yaml, the stored instance is
 * null and the /api/metrics handler returns 404.
 */

import type { PromMetrics } from "@agent-valley/core/observability/prom-metrics"

export interface MetricsEndpointConfig {
  enabled: boolean
  path: string
  metrics: PromMetrics
}

declare global {
  // biome-ignore lint: global augmentation for singleton
  var __agent_valley_metrics__: MetricsEndpointConfig | undefined
}

export function setMetricsEndpoint(cfg: MetricsEndpointConfig): void {
  globalThis.__agent_valley_metrics__ = cfg
}

export function getMetricsEndpoint(): MetricsEndpointConfig | null {
  return globalThis.__agent_valley_metrics__ ?? null
}
