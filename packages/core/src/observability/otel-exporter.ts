/**
 * OpenTelemetry exporter — lightweight OTLP/HTTP JSON sender with no
 * external dependencies. Supports spans and counter-style metrics.
 *
 * Disabled by default: `createOtelExporter({ enabled: false })` returns
 * a zero-cost no-op. When enabled, buffered spans/metrics are flushed to
 * the configured OTLP endpoint on a timer.
 *
 * Safety:
 *   - Network errors are swallowed and counted via the optional metrics
 *     handle (av_observability_errors_total{exporter="otel"}). They are
 *     never re-thrown into orchestrator flow.
 *   - Do not include credentials or API keys in span/metric attributes.
 *
 * Reference:
 *   docs/plans/v0-2-bigbang-design.md § 3.1 (D), § 5.8, § 6.6
 *   https://opentelemetry.io/docs/specs/otlp/
 */

import { logger } from "./logger"
import type { PromMetrics } from "./prom-metrics"

export interface SpanData {
  name: string
  /** Milliseconds since unix epoch. */
  startTimeMs: number
  /** Milliseconds since unix epoch. */
  endTimeMs: number
  status?: "ok" | "error"
  attributes?: Record<string, string | number | boolean>
}

export interface OtelConfig {
  enabled: boolean
  endpoint: string
  serviceName: string
  /** Timer interval for flushing to the collector. Defaults to 5_000 ms. */
  flushIntervalMs?: number
  /** Injected metrics collector used to track exporter errors. Optional. */
  metrics?: PromMetrics
}

export interface OtelExporter {
  recordSpan(span: SpanData): void
  recordCounter(name: string, value: number, attrs?: Record<string, string>): void
  /** Flush pending batches. Safe to call when disabled (no-op). */
  flush(): Promise<void>
  /** Stop the flush timer and drain remaining buffers. */
  shutdown(): Promise<void>
  readonly enabled: boolean
}

// ── Disabled (no-op) exporter ──────────────────────────────────────

class DisabledOtelExporter implements OtelExporter {
  readonly enabled = false
  recordSpan(_span: SpanData): void {}
  recordCounter(_name: string, _value: number, _attrs?: Record<string, string>): void {}
  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

// ── Active exporter ─────────────────────────────────────────────────

interface CounterBucket {
  name: string
  value: number
  attrs: Record<string, string>
}

function randomIdHex(bytes: number): string {
  const out = new Uint8Array(bytes)
  // Use Web Crypto when available, fall back to Math.random.
  const g: typeof globalThis & { crypto?: Crypto } = globalThis as typeof globalThis & { crypto?: Crypto }
  if (g.crypto && typeof g.crypto.getRandomValues === "function") {
    g.crypto.getRandomValues(out)
  } else {
    for (let i = 0; i < bytes; i++) out[i] = Math.floor(Math.random() * 256)
  }
  let hex = ""
  for (let i = 0; i < bytes; i++) {
    const byte = out[i]
    if (byte === undefined) continue
    hex += byte.toString(16).padStart(2, "0")
  }
  return hex
}

function toNanos(ms: number): string {
  // OTLP JSON expects stringified nanoseconds. Use BigInt (ES2020+) to
  // avoid precision loss beyond 2^53 ms.
  const nanos = BigInt(Math.floor(ms)) * BigInt(1_000_000)
  return nanos.toString()
}

function toAttributeValue(v: string | number | boolean): Record<string, unknown> {
  if (typeof v === "string") return { stringValue: v }
  if (typeof v === "boolean") return { boolValue: v }
  if (Number.isInteger(v)) return { intValue: String(v) }
  return { doubleValue: v }
}

function toAttributes(obj: Record<string, string | number | boolean> | undefined): unknown[] {
  if (!obj) return []
  return Object.entries(obj).map(([key, value]) => ({
    key,
    value: toAttributeValue(value),
  }))
}

class ActiveOtelExporter implements OtelExporter {
  readonly enabled = true
  private readonly endpoint: string
  private readonly serviceName: string
  private readonly metrics: PromMetrics | undefined

  private spanBuffer: SpanData[] = []
  private counterBuffer: CounterBucket[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private readonly flushIntervalMs: number
  private shuttingDown = false

  constructor(cfg: OtelConfig) {
    // Strip trailing slash for predictable /v1/traces and /v1/metrics joins.
    this.endpoint = cfg.endpoint.replace(/\/+$/, "")
    this.serviceName = cfg.serviceName
    this.metrics = cfg.metrics
    this.flushIntervalMs = cfg.flushIntervalMs ?? 5_000

    this.flushTimer = setInterval(() => {
      void this.flush()
    }, this.flushIntervalMs)
    // Prevent the flush timer from blocking process exit when unref'd env.
    const t = this.flushTimer as { unref?: () => void }
    if (typeof t.unref === "function") t.unref()
  }

  recordSpan(span: SpanData): void {
    if (this.shuttingDown) return
    this.spanBuffer.push(span)
  }

  recordCounter(name: string, value: number, attrs: Record<string, string> = {}): void {
    if (this.shuttingDown) return
    if (!Number.isFinite(value) || value < 0) return
    this.counterBuffer.push({ name, value, attrs })
  }

  async flush(): Promise<void> {
    const spans = this.spanBuffer
    const counters = this.counterBuffer
    this.spanBuffer = []
    this.counterBuffer = []

    if (spans.length > 0) {
      await this.sendTraces(spans)
    }
    if (counters.length > 0) {
      await this.sendMetrics(counters)
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    await this.flush()
  }

  private recordExporterError(err: unknown): void {
    // Never throw. Bump the self-counter if metrics is wired.
    try {
      this.metrics?.counter("av_observability_errors_total", { exporter: "otel" }).inc()
    } catch {
      /* counter must never throw, but guard anyway */
    }
    logger.debug("otel-exporter", "OTel export failed (swallowed)", { error: String(err) })
  }

  private async sendTraces(spans: SpanData[]): Promise<void> {
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: toAttributes({ "service.name": this.serviceName }),
          },
          scopeSpans: [
            {
              scope: { name: "agent-valley" },
              spans: spans.map((s) => ({
                traceId: randomIdHex(16),
                spanId: randomIdHex(8),
                name: s.name,
                kind: 1,
                startTimeUnixNano: toNanos(s.startTimeMs),
                endTimeUnixNano: toNanos(s.endTimeMs),
                attributes: toAttributes(s.attributes),
                status: s.status === "error" ? { code: 2 } : { code: 1 },
              })),
            },
          ],
        },
      ],
    }
    await this.postJson(`${this.endpoint}/v1/traces`, payload)
  }

  private async sendMetrics(counters: CounterBucket[]): Promise<void> {
    const nowNanos = toNanos(Date.now())
    const payload = {
      resourceMetrics: [
        {
          resource: {
            attributes: toAttributes({ "service.name": this.serviceName }),
          },
          scopeMetrics: [
            {
              scope: { name: "agent-valley" },
              metrics: counters.map((c) => ({
                name: c.name,
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: [
                    {
                      startTimeUnixNano: nowNanos,
                      timeUnixNano: nowNanos,
                      asDouble: c.value,
                      attributes: toAttributes(c.attrs),
                    },
                  ],
                },
              })),
            },
          ],
        },
      ],
    }
    await this.postJson(`${this.endpoint}/v1/metrics`, payload)
  }

  private async postJson(url: string, body: unknown): Promise<void> {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 2_000)
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        })
        if (!res.ok) {
          this.recordExporterError(new Error(`OTLP POST ${url} -> HTTP ${res.status}`))
        }
      } finally {
        clearTimeout(timer)
      }
    } catch (err) {
      this.recordExporterError(err)
    }
  }
}

// ── Factory ────────────────────────────────────────────────────────

/**
 * Create an OTel exporter. Pass `enabled: false` to get a zero-cost
 * no-op. When `enabled: true`, the exporter buffers spans and counter
 * samples and flushes to the OTLP/HTTP JSON endpoint on a timer.
 *
 * All errors are internally swallowed. Callers do not need try/catch.
 */
export function createOtelExporter(cfg: OtelConfig): OtelExporter {
  if (!cfg.enabled) return new DisabledOtelExporter()

  if (!cfg.endpoint || !/^https?:\/\//.test(cfg.endpoint)) {
    // Missing / malformed endpoint — fall back to no-op + audit log. This
    // avoids start-time crashes from a typo in valley.yaml.
    logger.warn("otel-exporter", "OTel endpoint missing or invalid; exporter disabled", {
      endpoint: cfg.endpoint ?? "(unset)",
      fixHint: "Set observability.otel.endpoint to http(s)://host:port in valley.yaml",
    })
    return new DisabledOtelExporter()
  }
  return new ActiveOtelExporter(cfg)
}

export function createNoopOtelExporter(): OtelExporter {
  return new DisabledOtelExporter()
}
