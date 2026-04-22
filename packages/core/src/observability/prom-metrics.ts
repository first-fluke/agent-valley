/**
 * Prometheus metrics — self-contained counter / histogram / gauge with
 * Prometheus text exposition format (version 0.0.4) output.
 *
 * Zero external dependencies. Safe to call when disabled — the disabled
 * singleton returns no-op handles and an empty render() string.
 *
 * Reference:
 *   docs/plans/v0-2-bigbang-design.md § 3.1 (D), § 5.8, § 6.6
 *   https://prometheus.io/docs/instrumenting/exposition_formats/
 *
 * Metric naming follows the `av_` prefix for project-wide namespacing.
 */

export interface Counter {
  inc(value?: number): void
}

export interface Histogram {
  observe(value: number): void
}

export interface Gauge {
  set(value: number): void
  inc(value?: number): void
  dec(value?: number): void
}

export interface PromMetrics {
  counter(name: string, labels?: Record<string, string>): Counter
  histogram(name: string, labels?: Record<string, string>): Histogram
  gauge(name: string, labels?: Record<string, string>): Gauge
  /** Render all metrics in Prometheus text format (version 0.0.4). */
  render(): string
  /** True when metrics are actively collected and exposed. */
  readonly enabled: boolean
}

// ── Internal storage ────────────────────────────────────────────────

interface HistogramBucket {
  le: number
  count: number
}

interface HistogramState {
  buckets: HistogramBucket[]
  sum: number
  count: number
}

type MetricKind = "counter" | "histogram" | "gauge"

interface MetricFamily {
  name: string
  kind: MetricKind
  help: string
  /** Sub-series keyed by `labelKey(labels)`. */
  series: Map<
    string,
    {
      labels: Record<string, string>
      counter?: number
      gauge?: number
      histogram?: HistogramState
    }
  >
}

/** Default histogram buckets (seconds). */
const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900, 3600]

// Known metric help strings — registered so render() emits HELP/TYPE lines
// regardless of whether the metric has been observed.
const KNOWN_HELP: Record<string, { kind: MetricKind; help: string }> = {
  av_agent_runs_total: { kind: "counter", help: "Total agent run attempts, labeled by agent type and outcome." },
  av_agent_duration_seconds: { kind: "histogram", help: "Agent run duration in seconds." },
  av_retry_queue_size: { kind: "gauge", help: "Number of entries currently in the retry queue." },
  av_budget_used_usd: { kind: "gauge", help: "Budget (USD) consumed, labeled by scope (issue | daily)." },
  av_dag_cycles_total: { kind: "counter", help: "Number of DAG cycles detected since process start." },
  av_observability_errors_total: {
    kind: "counter",
    help: "Number of internal observability exporter errors, labeled by exporter name.",
  },
}

function labelKey(labels?: Record<string, string>): string {
  if (!labels) return ""
  const keys = Object.keys(labels).sort()
  return keys.map((k) => `${k}=${labels[k]}`).join(",")
}

function formatLabels(labels: Record<string, string>, extra?: Record<string, string>): string {
  const merged: Record<string, string> = { ...labels, ...(extra ?? {}) }
  const keys = Object.keys(merged).sort()
  if (keys.length === 0) return ""
  const parts = keys.map((k) => {
    const v = merged[k] ?? ""
    // Escape per Prometheus text format: backslash, newline, double quote.
    const escaped = v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"')
    return `${k}="${escaped}"`
  })
  return `{${parts.join(",")}}`
}

// ── Disabled (no-op) implementation ────────────────────────────────

class NoopCounter implements Counter {
  inc(_value?: number): void {}
}

class NoopHistogram implements Histogram {
  observe(_value: number): void {}
}

class NoopGauge implements Gauge {
  set(_value: number): void {}
  inc(_value?: number): void {}
  dec(_value?: number): void {}
}

class DisabledPromMetrics implements PromMetrics {
  readonly enabled = false
  private readonly noopCounter = new NoopCounter()
  private readonly noopHistogram = new NoopHistogram()
  private readonly noopGauge = new NoopGauge()

  counter(_name: string, _labels?: Record<string, string>): Counter {
    return this.noopCounter
  }
  histogram(_name: string, _labels?: Record<string, string>): Histogram {
    return this.noopHistogram
  }
  gauge(_name: string, _labels?: Record<string, string>): Gauge {
    return this.noopGauge
  }
  render(): string {
    return ""
  }
}

// ── Active implementation ──────────────────────────────────────────

class ActivePromMetrics implements PromMetrics {
  readonly enabled = true
  private readonly families = new Map<string, MetricFamily>()

  constructor() {
    // Pre-register known families so render() emits HELP/TYPE headers
    // even before any observation. Keeps scrapes deterministic.
    for (const [name, meta] of Object.entries(KNOWN_HELP)) {
      this.families.set(name, { name, kind: meta.kind, help: meta.help, series: new Map() })
    }
  }

  private getFamily(name: string, kind: MetricKind): MetricFamily {
    let fam = this.families.get(name)
    if (!fam) {
      const known = KNOWN_HELP[name]
      fam = { name, kind: known?.kind ?? kind, help: known?.help ?? "", series: new Map() }
      this.families.set(name, fam)
    }
    if (fam.kind !== kind) {
      // Don't throw into hot path; downgrade to no-op to avoid corrupting output.
      // This prevents a typo from breaking the Prometheus scrape response.
      return { name, kind, help: "", series: new Map() }
    }
    return fam
  }

  private getSeries(fam: MetricFamily, labels: Record<string, string> | undefined) {
    const key = labelKey(labels)
    let s = fam.series.get(key)
    if (!s) {
      s = { labels: { ...(labels ?? {}) } }
      fam.series.set(key, s)
    }
    return s
  }

  counter(name: string, labels?: Record<string, string>): Counter {
    const fam = this.getFamily(name, "counter")
    const series = this.getSeries(fam, labels)
    series.counter ??= 0
    return {
      inc: (value: number = 1) => {
        if (!Number.isFinite(value) || value < 0) return
        series.counter = (series.counter ?? 0) + value
      },
    }
  }

  histogram(name: string, labels?: Record<string, string>): Histogram {
    const fam = this.getFamily(name, "histogram")
    const series = this.getSeries(fam, labels)
    if (!series.histogram) {
      series.histogram = {
        buckets: DEFAULT_BUCKETS.map((le) => ({ le, count: 0 })),
        sum: 0,
        count: 0,
      }
    }
    return {
      observe: (value: number) => {
        if (!Number.isFinite(value) || value < 0) return
        const hist = series.histogram
        if (!hist) return
        hist.sum += value
        hist.count += 1
        for (const b of hist.buckets) {
          if (value <= b.le) b.count += 1
        }
      },
    }
  }

  gauge(name: string, labels?: Record<string, string>): Gauge {
    const fam = this.getFamily(name, "gauge")
    const series = this.getSeries(fam, labels)
    series.gauge ??= 0
    return {
      set: (value: number) => {
        if (!Number.isFinite(value)) return
        series.gauge = value
      },
      inc: (value: number = 1) => {
        if (!Number.isFinite(value)) return
        series.gauge = (series.gauge ?? 0) + value
      },
      dec: (value: number = 1) => {
        if (!Number.isFinite(value)) return
        series.gauge = (series.gauge ?? 0) - value
      },
    }
  }

  render(): string {
    const lines: string[] = []
    const names = [...this.families.keys()].sort()
    for (const name of names) {
      const fam = this.families.get(name)
      if (!fam) continue
      if (fam.help) lines.push(`# HELP ${fam.name} ${fam.help}`)
      lines.push(`# TYPE ${fam.name} ${fam.kind}`)
      if (fam.series.size === 0) continue

      for (const series of fam.series.values()) {
        if (fam.kind === "counter") {
          lines.push(`${fam.name}${formatLabels(series.labels)} ${series.counter ?? 0}`)
        } else if (fam.kind === "gauge") {
          lines.push(`${fam.name}${formatLabels(series.labels)} ${series.gauge ?? 0}`)
        } else if (fam.kind === "histogram") {
          const hist = series.histogram
          if (!hist) continue
          for (const b of hist.buckets) {
            lines.push(`${fam.name}_bucket${formatLabels(series.labels, { le: String(b.le) })} ${b.count}`)
          }
          lines.push(`${fam.name}_bucket${formatLabels(series.labels, { le: "+Inf" })} ${hist.count}`)
          lines.push(`${fam.name}_sum${formatLabels(series.labels)} ${hist.sum}`)
          lines.push(`${fam.name}_count${formatLabels(series.labels)} ${hist.count}`)
        }
      }
    }
    return lines.length > 0 ? `${lines.join("\n")}\n` : ""
  }
}

// ── Factories ──────────────────────────────────────────────────────

/** Create a disabled (no-op) metrics instance. Zero overhead. */
export function createNoopPromMetrics(): PromMetrics {
  return new DisabledPromMetrics()
}

/**
 * Create a Prometheus metrics collector.
 *
 * Pass `{ enabled: false }` (default) to get a zero-cost no-op.
 * Pass `{ enabled: true }` to collect and render metrics.
 */
export function createPromMetrics(options: { enabled?: boolean } = {}): PromMetrics {
  return options.enabled === true ? new ActivePromMetrics() : new DisabledPromMetrics()
}
