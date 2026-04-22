/**
 * ObservabilityHooks — Thin aggregator passed into OrchestratorCore so
 * call sites can fire a single method without branching on which
 * exporter is enabled. Every method must be safe to call regardless of
 * whether OTel / Prom is enabled (no-op when disabled).
 *
 * Reference: docs/plans/v0-2-bigbang-design.md § 3.1 (D), § 5.8
 */

import type { OtelExporter } from "./otel-exporter"
import { createNoopOtelExporter } from "./otel-exporter"
import type { PromMetrics } from "./prom-metrics"
import { createNoopPromMetrics } from "./prom-metrics"

export interface ObservabilityHooks {
  readonly metrics: PromMetrics
  readonly otel: OtelExporter

  /** Called when an agent run is about to start. */
  onAgentStart(input: { agentType: string; issueKey: string; issueId: string; attemptId: string }): void
  /** Called when an agent run finishes successfully. */
  onAgentDone(input: {
    agentType: string
    issueKey: string
    issueId: string
    attemptId: string
    durationMs: number
  }): void
  /** Called when an agent run fails (recoverable or terminal). */
  onAgentFailed(input: {
    agentType: string
    issueKey: string
    issueId: string
    attemptId: string
    durationMs: number
    retryable: boolean
  }): void
  /** Called when an agent run is cancelled (left in-progress / kill). */
  onAgentCancelled(input: { issueKey: string; issueId: string; attemptId?: string }): void
  /** Update the retry queue gauge. */
  onRetryQueueChanged(size: number): void
  /** Record a DAG cycle detection. */
  onDagCycle(): void
}

interface TimerState {
  startedAtMs: number
}

/**
 * Build an ObservabilityHooks instance backed by injected metrics + OTel.
 * Both are optional — when omitted, no-op implementations are used.
 *
 * Exporter exceptions are swallowed internally so orchestrator flow is
 * never interrupted by observability failures.
 */
export function createObservabilityHooks(opts: { metrics?: PromMetrics; otel?: OtelExporter }): ObservabilityHooks {
  const metrics = opts.metrics ?? createNoopPromMetrics()
  const otel = opts.otel ?? createNoopOtelExporter()

  // Track start times per attempt so agent.start / agent.done can produce
  // a span without mutating RunAttempt itself.
  const timers = new Map<string, TimerState>()

  const bump = (fn: () => void) => {
    try {
      fn()
    } catch {
      // Metrics must never interrupt orchestrator flow. The active
      // metrics implementation already guards; the try/catch is belt +
      // suspenders against future impls.
      try {
        metrics.counter("av_observability_errors_total", { exporter: "prometheus" }).inc()
      } catch {
        /* truly give up */
      }
    }
  }

  return {
    metrics,
    otel,
    onAgentStart({ agentType, issueKey, issueId, attemptId }) {
      timers.set(attemptId, { startedAtMs: Date.now() })
      bump(() => {
        // No counter on start — runs_total is incremented on terminal state
        // so {result} cardinality stays bounded to success|failure|cancelled.
      })
      try {
        otel.recordCounter("av_agent_runs_started", 1, { agent: agentType })
      } catch {
        /* swallowed inside exporter */
      }
      // Span is emitted on completion so duration is known.
      void issueKey
      void issueId
    },
    onAgentDone({ agentType, issueKey, issueId, attemptId, durationMs }) {
      const state = timers.get(attemptId)
      timers.delete(attemptId)
      bump(() => {
        metrics.counter("av_agent_runs_total", { agent: agentType, result: "success" }).inc()
        metrics.histogram("av_agent_duration_seconds", { agent: agentType }).observe(durationMs / 1000)
      })
      try {
        otel.recordCounter("av_agent_runs_total", 1, { agent: agentType, result: "success" })
        const startedAtMs = state?.startedAtMs ?? Date.now() - durationMs
        otel.recordSpan({
          name: "agent.run",
          startTimeMs: startedAtMs,
          endTimeMs: Date.now(),
          status: "ok",
          attributes: { agent: agentType, issue_key: issueKey, issue_id: issueId, result: "success" },
        })
      } catch {
        /* swallowed */
      }
    },
    onAgentFailed({ agentType, issueKey, issueId, attemptId, durationMs, retryable }) {
      const state = timers.get(attemptId)
      timers.delete(attemptId)
      const result = retryable ? "failure_retryable" : "failure"
      bump(() => {
        metrics.counter("av_agent_runs_total", { agent: agentType, result }).inc()
        metrics.histogram("av_agent_duration_seconds", { agent: agentType }).observe(durationMs / 1000)
      })
      try {
        otel.recordCounter("av_agent_runs_total", 1, { agent: agentType, result })
        const startedAtMs = state?.startedAtMs ?? Date.now() - durationMs
        otel.recordSpan({
          name: "agent.run",
          startTimeMs: startedAtMs,
          endTimeMs: Date.now(),
          status: "error",
          attributes: { agent: agentType, issue_key: issueKey, issue_id: issueId, result },
        })
      } catch {
        /* swallowed */
      }
    },
    onAgentCancelled({ issueKey, issueId, attemptId }) {
      if (attemptId) timers.delete(attemptId)
      bump(() => {
        metrics.counter("av_agent_runs_total", { agent: "unknown", result: "cancelled" }).inc()
      })
      try {
        otel.recordCounter("av_agent_runs_total", 1, { result: "cancelled" })
      } catch {
        /* swallowed */
      }
      void issueKey
      void issueId
    },
    onRetryQueueChanged(size: number) {
      bump(() => {
        metrics.gauge("av_retry_queue_size").set(size)
      })
    },
    onDagCycle() {
      bump(() => {
        metrics.counter("av_dag_cycles_total").inc()
      })
      try {
        otel.recordCounter("av_dag_cycles_total", 1)
      } catch {
        /* swallowed */
      }
    },
  }
}

/** Default (no-op) hooks — used when no observability is configured. */
export function createNoopObservabilityHooks(): ObservabilityHooks {
  return createObservabilityHooks({})
}
