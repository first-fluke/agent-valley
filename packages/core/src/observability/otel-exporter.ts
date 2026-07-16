/**
 * OpenTelemetry exporter — lightweight OTLP/HTTP JSON sender with no
 * external dependencies. Supports spans, counter-style (Sum) metrics,
 * and histogram metrics (used for GenAI token-usage collection).
 *
 * Disabled by default: `createOtelExporter({ enabled: false })` returns
 * a zero-cost no-op. When enabled, buffered spans/metrics are flushed to
 * the configured OTLP endpoint on a timer.
 *
 * Wire format: this exporter targets the JSON encoding the OTel
 * Collector's OTLP/HTTP receiver actually accepts — trace/span IDs as
 * lowercase hex strings (the Collector's `pcommon.TraceID`/`SpanID` JSON
 * (un)marshaling uses hex, not base64, despite `bytes` being the proto
 * wire type), int64 fields (nanosecond timestamps, histogram `count` /
 * `bucketCounts`) as decimal strings to avoid JS number precision loss,
 * and attribute values as `AnyValue` (`{stringValue: ...}` etc.). A real
 * OTel Collector / GenAI-aware backend (Langfuse, Tempo, etc.) can
 * ingest this payload as-is.
 *
 * GenAI semantic conventions (stable, v1.43.0 —
 * https://opentelemetry.io/docs/specs/semconv/gen-ai/): attribute
 * naming and the `gen_ai.client.token.usage` histogram are the caller's
 * responsibility (see observability/hooks.ts) — this module is a
 * generic OTLP sender and does not hardcode GenAI semantics itself,
 * beyond providing the histogram primitive GenAI metrics need.
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
 *   https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */

import { logger } from "./logger"
import type { PromMetrics } from "./prom-metrics"

/** OTLP SpanKind enum values (opentelemetry.proto.trace.v1.Span.SpanKind). */
export const SPAN_KIND = {
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
  PRODUCER: 4,
  CONSUMER: 5,
} as const

export interface SpanData {
  name: string
  /** Milliseconds since unix epoch. */
  startTimeMs: number
  /** Milliseconds since unix epoch. */
  endTimeMs: number
  status?: "ok" | "error"
  attributes?: Record<string, string | number | boolean>
  /** OTLP SpanKind (see `SPAN_KIND`). Defaults to `SPAN_KIND.INTERNAL`. GenAI spans (agent/model invocations) SHOULD use `SPAN_KIND.CLIENT`. */
  kind?: number
  /**
   * Trace-correlation key linking spans that belong to the same logical
   * run (e.g. an agent attemptId). Spans sharing the same `runId` are
   * emitted under one OTel traceId: the first span for a `runId` becomes
   * the trace root, and each subsequent span for that `runId` becomes
   * the child of the immediately preceding one (parentSpanId linkage).
   * Omit for a standalone single-span trace (pre-existing behavior — a
   * fresh random traceId is generated).
   */
  runId?: string
  /**
   * Marks this span as the last one for `runId`. After emission the
   * exporter forgets the `runId` -> traceId/spanId link, bounding memory
   * for long-lived processes. Ignored when `runId` is omitted.
   */
  terminal?: boolean
}

export interface OtelConfig {
  enabled: boolean
  /**
   * OTLP/HTTP base endpoint (e.g. `http://localhost:4318`). Falls back
   * to the standard `OTEL_EXPORTER_OTLP_ENDPOINT` env var when empty, so
   * a Collector run with default env-based config (no valley.yaml edit)
   * still gets picked up. Fails soft (no-op exporter, no crash) when
   * neither is set or the resolved value is not a valid http(s) URL.
   */
  endpoint: string
  /** Falls back to the standard `OTEL_SERVICE_NAME` env var, then to `"agent-valley"`, when empty. */
  serviceName: string
  /** Timer interval for flushing to the collector. Defaults to 5_000 ms. */
  flushIntervalMs?: number
  /** Injected metrics collector used to track exporter errors. Optional. */
  metrics?: PromMetrics
}

export interface OtelExporter {
  recordSpan(span: SpanData): void
  recordCounter(name: string, value: number, attrs?: Record<string, string>): void
  /**
   * Record one histogram observation (OTLP Histogram metric, DELTA
   * aggregation temporality — each flush interval's buffered points are
   * their own delta batch, matching how `recordCounter` already treats
   * each flush as an isolated interval). Used for GenAI token-usage
   * collection (`gen_ai.client.token.usage`) — see hooks.ts.
   */
  recordHistogram(name: string, value: number, attrs?: Record<string, string>): void
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
  recordHistogram(_name: string, _value: number, _attrs?: Record<string, string>): void {}
  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

// ── Active exporter ─────────────────────────────────────────────────

interface CounterBucket {
  name: string
  value: number
  attrs: Record<string, string>
}

interface HistogramPoint {
  name: string
  value: number
  attrs: Record<string, string>
}

/** SpanData with trace/span ids resolved at recordSpan() time (not at flush time), so buffering/batching never affects correlation. */
interface ResolvedSpan extends SpanData {
  traceId: string
  spanId: string
  parentSpanId?: string
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

  private spanBuffer: ResolvedSpan[] = []
  private counterBuffer: CounterBucket[] = []
  private histogramBuffer: HistogramPoint[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private readonly flushIntervalMs: number
  private shuttingDown = false
  /** runId -> {traceId, lastSpanId of the most recent span for that run}. Cleared per-runId when a span sets `terminal: true`. */
  private readonly traceLinks = new Map<string, { traceId: string; lastSpanId: string }>()

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
    const { traceId, spanId, parentSpanId } = this.resolveIds(span)
    this.spanBuffer.push({ ...span, traceId, spanId, parentSpanId })
  }

  /**
   * Resolve traceId/spanId/parentSpanId for a span, applying `runId`
   * correlation when present. IDs are resolved here (at record time)
   * rather than at flush time, so batching/timer intervals never split
   * a run's spans across differently-generated traceIds.
   */
  private resolveIds(span: SpanData): { traceId: string; spanId: string; parentSpanId?: string } {
    const spanId = randomIdHex(8)
    if (!span.runId) {
      return { traceId: randomIdHex(16), spanId }
    }

    const existing = this.traceLinks.get(span.runId)
    const traceId = existing?.traceId ?? randomIdHex(16)
    const parentSpanId = existing?.lastSpanId

    if (span.terminal) {
      this.traceLinks.delete(span.runId)
    } else {
      this.traceLinks.set(span.runId, { traceId, lastSpanId: spanId })
    }

    return parentSpanId ? { traceId, spanId, parentSpanId } : { traceId, spanId }
  }

  recordCounter(name: string, value: number, attrs: Record<string, string> = {}): void {
    if (this.shuttingDown) return
    if (!Number.isFinite(value) || value < 0) return
    this.counterBuffer.push({ name, value, attrs })
  }

  recordHistogram(name: string, value: number, attrs: Record<string, string> = {}): void {
    if (this.shuttingDown) return
    if (!Number.isFinite(value) || value < 0) return
    this.histogramBuffer.push({ name, value, attrs })
  }

  async flush(): Promise<void> {
    const spans = this.spanBuffer
    const counters = this.counterBuffer
    const histograms = this.histogramBuffer
    this.spanBuffer = []
    this.counterBuffer = []
    this.histogramBuffer = []

    if (spans.length > 0) {
      await this.sendTraces(spans)
    }
    if (counters.length > 0 || histograms.length > 0) {
      await this.sendMetrics(counters, histograms)
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

  private async sendTraces(spans: ResolvedSpan[]): Promise<void> {
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
                traceId: s.traceId,
                spanId: s.spanId,
                ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
                name: s.name,
                kind: s.kind ?? SPAN_KIND.INTERNAL,
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

  private async sendMetrics(counters: CounterBucket[], histograms: HistogramPoint[]): Promise<void> {
    const nowNanos = toNanos(Date.now())
    const sumMetrics = counters.map((c) => ({
      name: c.name,
      sum: {
        aggregationTemporality: 2, // AGGREGATION_TEMPORALITY_CUMULATIVE
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
    }))
    // Single-observation histogram: one bucket spanning (-inf, +inf)
    // (bucketCounts=[1], explicitBounds=[] — a valid 1-bucket OTLP
    // histogram per the schema's `bucketCounts.length === explicitBounds.length + 1`
    // invariant) carrying exactly the one recorded value as both count
    // and sum. DELTA temporality: each flush's buffered points are a
    // fresh, isolated interval (mirrors how `sendMetrics`'s counters
    // already reset start=end time every flush).
    const histogramMetrics = histograms.map((h) => ({
      name: h.name,
      histogram: {
        aggregationTemporality: 1, // AGGREGATION_TEMPORALITY_DELTA
        dataPoints: [
          {
            startTimeUnixNano: nowNanos,
            timeUnixNano: nowNanos,
            count: "1",
            sum: h.value,
            min: h.value,
            max: h.value,
            bucketCounts: ["1"],
            explicitBounds: [],
            attributes: toAttributes(h.attrs),
          },
        ],
      },
    }))
    const payload = {
      resourceMetrics: [
        {
          resource: {
            attributes: toAttributes({ "service.name": this.serviceName }),
          },
          scopeMetrics: [
            {
              scope: { name: "agent-valley" },
              metrics: [...sumMetrics, ...histogramMetrics],
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
 * no-op. When `enabled: true`, the exporter buffers spans, counter
 * samples, and histogram samples, and flushes them to the OTLP/HTTP
 * JSON endpoint on a timer.
 *
 * Endpoint/serviceName resolution: `cfg.endpoint`/`cfg.serviceName`
 * (from valley.yaml) win when set; otherwise the standard OTel env vars
 * `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_SERVICE_NAME` are used, so a
 * Collector configured purely through env vars (no valley.yaml edit)
 * still gets picked up. Fails soft to a no-op exporter (never throws,
 * never crashes boot) when the resolved endpoint is still missing or
 * not a valid http(s) URL — the WARN log names the exact fix.
 *
 * All errors are internally swallowed. Callers do not need try/catch.
 */
export function createOtelExporter(cfg: OtelConfig): OtelExporter {
  if (!cfg.enabled) return new DisabledOtelExporter()

  const endpoint = cfg.endpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || ""
  const serviceName = cfg.serviceName || process.env.OTEL_SERVICE_NAME || "agent-valley"

  if (!endpoint || !/^https?:\/\//.test(endpoint)) {
    // Missing / malformed endpoint — fall back to no-op + audit log. This
    // avoids start-time crashes from a typo in valley.yaml or a missing
    // OTEL_EXPORTER_OTLP_ENDPOINT env var.
    logger.warn("otel-exporter", "OTel endpoint missing or invalid; exporter disabled", {
      endpoint: endpoint || "(unset)",
      fixHint:
        "Set observability.otel.endpoint to http(s)://host:port in valley.yaml, " +
        "or set the OTEL_EXPORTER_OTLP_ENDPOINT environment variable.",
    })
    return new DisabledOtelExporter()
  }
  return new ActiveOtelExporter({ ...cfg, endpoint, serviceName })
}

export function createNoopOtelExporter(): OtelExporter {
  return new DisabledOtelExporter()
}
