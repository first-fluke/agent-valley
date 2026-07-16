/**
 * ObservabilityHooks — Thin aggregator passed into OrchestratorCore so
 * call sites can fire a single method without branching on which
 * exporter is enabled. Every method must be safe to call regardless of
 * whether OTel / Prom is enabled (no-op when disabled).
 *
 * Reference: docs/plans/v0-2-bigbang-design.md § 3.1 (D), § 5.8
 */

import type { OtelExporter } from "./otel-exporter"
import { createNoopOtelExporter, SPAN_KIND } from "./otel-exporter"
import type { PromMetrics } from "./prom-metrics"
import { createNoopPromMetrics } from "./prom-metrics"

/**
 * Token usage surfaced by a session for the OTel GenAI semantic-
 * convention span attributes (`gen_ai.usage.*`). Optional everywhere it
 * appears — sessions that cannot report usage (e.g. some CLI fallbacks)
 * simply omit it and no gen_ai.usage.* attributes are attached.
 *
 * Follow-up wiring: `completion-handler.ts`'s onComplete/onError call
 * sites already have `completedAttempt.tokenUsage` in scope but do not
 * yet pass it through — a one-line addition
 * (`tokenUsage: completedAttempt.tokenUsage`) at those two call sites
 * completes the pipe end-to-end. Out of scope here (completion-handler.ts
 * is owned by another workstream).
 */
export interface HookTokenUsage {
  input: number
  output: number
  model?: string
}

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
    tokenUsage?: HookTokenUsage
  }): void
  /** Called when an agent run fails (recoverable or terminal). */
  onAgentFailed(input: {
    agentType: string
    issueKey: string
    issueId: string
    attemptId: string
    durationMs: number
    retryable: boolean
    tokenUsage?: HookTokenUsage
  }): void
  /** Called when an agent run is cancelled (left in-progress / kill). */
  onAgentCancelled(input: { issueKey: string; issueId: string; attemptId?: string }): void
  /** Update the retry queue gauge. */
  onRetryQueueChanged(size: number): void
  /** Record a DAG cycle detection. */
  onDagCycle(): void
}

/**
 * GenAI operation name (stable semconv v1.43.0 registry value) for spans
 * covering an agentic-coding-tool invocation. `agent-valley` spawns a
 * CLI agent (claude/codex/antigravity/cursor/grok) that autonomously drives
 * an LLM conversation, so `invoke_agent` is the closest registered operation —
 * see https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/.
 */
const GEN_AI_OPERATION_NAME = "invoke_agent"

/**
 * Maps agent-valley's internal agent type to the stable GenAI semconv
 * `gen_ai.system` registry value (the LLM *provider*, not the CLI tool)
 * — see https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/.
 * Falls back to the raw agentType string for any future agent type not
 * yet mapped here, so a new agent type degrades gracefully (a
 * non-registry value, but never a missing/crashing attribute) rather
 * than throwing.
 */
const GEN_AI_SYSTEM_BY_AGENT_TYPE: Record<string, string> = {
  claude: "anthropic",
  codex: "openai",
  antigravity: "gcp.antigravity",
  cursor: "cursor",
  grok: "xai",
}

function mapAgentTypeToGenAiSystem(agentType: string): string {
  return GEN_AI_SYSTEM_BY_AGENT_TYPE[agentType] ?? agentType
}

/**
 * Span name per the GenAI semconv naming rule: `"{operation} {model}"`
 * when the model is known, else just the operation name. The model is
 * only known post-hoc (from a completed session's tokenUsage), so the
 * root `invoke_agent` span emitted at spawn time has no model suffix.
 */
function buildGenAiSpanName(model?: string): string {
  return model ? `${GEN_AI_OPERATION_NAME} ${model}` : GEN_AI_OPERATION_NAME
}

/**
 * Build the gen_ai.* attribute set for a run's OTel span, following the
 * stable OTel GenAI semantic conventions
 * (https://opentelemetry.io/docs/specs/semconv/gen-ai/). `issue_key`
 * `issue_id` / `agent_type` are agent-valley-specific correlation
 * attributes kept alongside (not part of the GenAI convention, but
 * useful for querying a trace back to its issue / underlying CLI tool
 * — `gen_ai.system` alone only identifies the LLM provider, not which
 * of claude/codex/antigravity/cursor/grok invoked it).
 */
export function buildGenAiAttributes(input: {
  agentType: string
  issueKey: string
  issueId: string
  result: string
  tokenUsage?: HookTokenUsage
}): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {
    "gen_ai.operation.name": GEN_AI_OPERATION_NAME,
    "gen_ai.system": mapAgentTypeToGenAiSystem(input.agentType),
    agent_type: input.agentType,
    issue_key: input.issueKey,
    issue_id: input.issueId,
    result: input.result,
  }
  if (input.tokenUsage) {
    if (input.tokenUsage.model) attrs["gen_ai.request.model"] = input.tokenUsage.model
    attrs["gen_ai.usage.input_tokens"] = input.tokenUsage.input
    attrs["gen_ai.usage.output_tokens"] = input.tokenUsage.output
  }
  return attrs
}

/**
 * Emit the GenAI `gen_ai.client.token.usage` histogram (stable semconv
 * v1.43.0 — https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/),
 * one data point per token direction (`gen_ai.token.type` = "input" |
 * "output"). No-op (does nothing, never throws on its own — callers
 * still wrap in try/catch) when `tokenUsage` is absent.
 */
function recordGenAiTokenUsageMetrics(
  otel: OtelExporter,
  agentType: string,
  tokenUsage: HookTokenUsage | undefined,
): void {
  if (!tokenUsage) return
  const baseAttrs: Record<string, string> = {
    "gen_ai.operation.name": GEN_AI_OPERATION_NAME,
    "gen_ai.system": mapAgentTypeToGenAiSystem(agentType),
  }
  if (tokenUsage.model) baseAttrs["gen_ai.request.model"] = tokenUsage.model
  otel.recordHistogram("gen_ai.client.token.usage", tokenUsage.input, { ...baseAttrs, "gen_ai.token.type": "input" })
  otel.recordHistogram("gen_ai.client.token.usage", tokenUsage.output, { ...baseAttrs, "gen_ai.token.type": "output" })
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
        // Root span for this run's trace. `runId: attemptId` links every
        // later span for the same attempt (agent.run on completion/
        // failure/cancellation) into one OTel trace with proper
        // parent/child spanId linkage instead of a fresh random traceId
        // per event. `SPAN_KIND.CLIENT`: GenAI spans (agent/model
        // invocations) SHOULD use CLIENT per the semconv spec.
        const now = Date.now()
        otel.recordSpan({
          name: buildGenAiSpanName(),
          startTimeMs: now,
          endTimeMs: now,
          status: "ok",
          kind: SPAN_KIND.CLIENT,
          runId: attemptId,
          attributes: buildGenAiAttributes({ agentType, issueKey, issueId, result: "spawned" }),
        })
      } catch {
        /* swallowed inside exporter */
      }
    },
    onAgentDone({ agentType, issueKey, issueId, attemptId, durationMs, tokenUsage }) {
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
          name: buildGenAiSpanName(tokenUsage?.model),
          startTimeMs: startedAtMs,
          endTimeMs: Date.now(),
          status: "ok",
          kind: SPAN_KIND.CLIENT,
          runId: attemptId,
          terminal: true,
          attributes: buildGenAiAttributes({ agentType, issueKey, issueId, result: "success", tokenUsage }),
        })
        // gen_ai.client.token.usage histogram (stable semconv metric) —
        // no-op when the session didn't report tokenUsage.
        recordGenAiTokenUsageMetrics(otel, agentType, tokenUsage)
      } catch {
        /* swallowed */
      }
    },
    onAgentFailed({ agentType, issueKey, issueId, attemptId, durationMs, retryable, tokenUsage }) {
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
          name: buildGenAiSpanName(tokenUsage?.model),
          startTimeMs: startedAtMs,
          endTimeMs: Date.now(),
          status: "error",
          kind: SPAN_KIND.CLIENT,
          runId: attemptId,
          terminal: true,
          attributes: buildGenAiAttributes({ agentType, issueKey, issueId, result, tokenUsage }),
        })
        // gen_ai.client.token.usage histogram — some retryable failures
        // still surface partial token usage (e.g. a mid-stream timeout);
        // no-op when tokenUsage is absent.
        recordGenAiTokenUsageMetrics(otel, agentType, tokenUsage)
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
        // Emit a terminal span so the exporter's runId->traceId link for
        // this attempt is released (see otel-exporter.ts `terminal`).
        // Without this, an attempt cancelled before agent.done/failed
        // would leak an entry in the exporter's in-memory trace map.
        if (attemptId) {
          const now = Date.now()
          otel.recordSpan({
            name: "agent.cancelled",
            startTimeMs: now,
            endTimeMs: now,
            status: "error",
            runId: attemptId,
            terminal: true,
            attributes: { issue_key: issueKey, issue_id: issueId, result: "cancelled" },
          })
        }
      } catch {
        /* swallowed */
      }
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
