/**
 * AgentRunnerPort — Domain-layer interface for spawning and controlling
 * running agent sessions. Infrastructure adapters implement this against
 * the concrete `AgentSession` plugin system (Claude, Codex, Gemini).
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 4.4 (PR4).
 *
 * Invariant: no imports from outside `domain/`. Validated by
 * scripts/harness/validate.sh.
 */

import type { Issue, Workspace } from "../models"

// ── Spawn input ───────────────────────────────────────────────────────

export interface SpawnInput {
  issue: Issue
  workspace: Workspace
  prompt: string
  /** Agent type name registered with the session factory (e.g. "claude"). */
  agentType: string
  /** Agent execution budget in milliseconds. Adapters are free to round. */
  timeoutMs?: number
  /** Attempt id minted upstream so events carry a stable correlation id. */
  attemptId: string
}

// ── Run handle ────────────────────────────────────────────────────────

/** Cancelable subscription returned by `onEvent`. */
export type Unsubscribe = () => void

/** Live intervention commands an operator can send mid-run. */
export type InterventionCommand =
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "append_prompt"; text: string }
  | { kind: "abort"; reason: string }

/** Capability flags; UIs use this to pre-disable unsupported controls. */
export type InterventionCapability = "pause" | "resume" | "append_prompt" | "abort"

/**
 * Lifecycle events observed on a run. Distinct from the richer
 * `sessions/agent-session.ts::AgentEvent` so Domain stays free of
 * transport-specific event shapes.
 */
export type AgentRunEvent =
  | { kind: "started"; attemptId: string }
  | { kind: "output"; attemptId: string; text: string }
  | { kind: "complete"; attemptId: string; exitCode: number | null }
  | { kind: "error"; attemptId: string; error: Error }

export interface RunHandle {
  readonly attemptId: string
  readonly issueKey: string
  /** Subscribe to the event stream. Returns an unsubscribe function. */
  onEvent(handler: (event: AgentRunEvent) => void): Unsubscribe
  /** Deliver an intervention. Rejects with `InterventionUnsupportedError` if unsupported. */
  send(cmd: InterventionCommand): Promise<void>
  /** Request graceful cancellation. */
  cancel(): Promise<void>
  /** Force kill (after cancel timeout). */
  kill(): Promise<void>
  /** Process liveness. */
  isAlive(): boolean
}

// ── Port ──────────────────────────────────────────────────────────────

export interface AgentRunnerPort {
  spawn(input: SpawnInput): Promise<RunHandle>
  /**
   * Static per-agent-type capability table. Does not inspect a live
   * session; UIs call this before issuing `send()`.
   */
  capabilities(agentType: string): InterventionCapability[]
}

// ── Errors ────────────────────────────────────────────────────────────

export class InterventionUnsupportedError extends Error {
  constructor(
    public readonly command: InterventionCommand["kind"],
    public readonly agentType: string,
  ) {
    super(
      `AgentRunnerPort: agent "${agentType}" does not support intervention "${command}".\n` +
        `  Fix: call capabilities("${agentType}") to pre-check before send(); disable the UI control if absent.\n` +
        `  Source: sessions/adapters/spawn-agent-runner.ts CAPABILITY_TABLE.`,
    )
    this.name = "InterventionUnsupportedError"
  }
}
