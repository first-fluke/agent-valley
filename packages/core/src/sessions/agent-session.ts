/**
 * AgentSession — Core abstraction for agent communication.
 *
 * Orchestrator uses this interface exclusively. Each agent (Codex, Claude, Gemini)
 * provides a session implementation that speaks the agent's native protocol internally.
 */

// ── Config ────────────────────────────────────────────────────────────────────

export interface AgentConfig {
  /** Agent type — determines which session implementation to use */
  type: string

  /** Model override (e.g. "sonnet", "gpt-5.3-codex") */
  model?: string

  /** Max execution time in seconds. Force-kill if exceeded. */
  timeout: number

  /** Git worktree path where the agent operates */
  workspacePath: string

  /** Additional env vars passed to the agent process */
  env?: Record<string, string>

  /**
   * Agent-specific options (pass-through, not interpreted by Orchestrator).
   * E.g. Codex sandbox permissions, Claude effort level, Gemini approval mode.
   */
  options?: Record<string, unknown>
}

// ── Result & Error ────────────────────────────────────────────────────────────

export interface RunResult {
  exitCode: number
  /** Final agent output (max 10KB, truncated per SPEC) */
  output: string
  durationMs: number
  /** List of file paths changed during execution */
  filesChanged: string[]
  /**
   * Token usage reported by the session adapter. Shape matches
   * `TokenUsage` in `../domain/budget` so it can be forwarded to
   * `BudgetService.recordUsage()` without re-mapping. Sessions that
   * cannot discover usage (e.g. gemini CLI fallback) return `undefined`
   * and BudgetService skips accumulation for that attempt.
   */
  tokenUsage?: {
    input: number
    output: number
    model: string
  }
}

export interface AgentError {
  /** Machine-readable code: TIMEOUT, CRASH, AUTH_FAILED, CANCELLED, UNKNOWN */
  code: "TIMEOUT" | "CRASH" | "AUTH_FAILED" | "CANCELLED" | "UNKNOWN"
  message: string
  exitCode?: number
  /** Orchestrator uses this to decide whether to retry */
  recoverable: boolean
}

// ── Events ────────────────────────────────────────────────────────────────────

export type AgentEvent =
  | { type: "output"; chunk: string }
  | { type: "toolUse"; tool: string; args: unknown }
  | { type: "fileChange"; path: string; changeType: "add" | "modify" | "delete" }
  | { type: "heartbeat"; timestamp: string }
  | { type: "complete"; result: RunResult }
  | { type: "error"; error: AgentError }

export type AgentEventType = AgentEvent["type"]

export type AgentEventHandler<T extends AgentEventType> = (event: Extract<AgentEvent, { type: T }>) => void

// ── Session Interface ─────────────────────────────────────────────────────────

export interface AgentSession {
  /** Start the agent process or connect to the server */
  start(config: AgentConfig): Promise<void>

  /** Send prompt and begin execution */
  execute(prompt: string): Promise<void>

  /** Request graceful cancellation of current execution */
  cancel(): Promise<void>

  /** Force-kill the agent process (after cancel timeout) */
  kill(): Promise<void>

  /** Check if the agent process is still alive */
  isAlive(): boolean

  /** Subscribe to agent events */
  on<T extends AgentEventType>(event: T, handler: AgentEventHandler<T>): void

  /** Unsubscribe from agent events */
  off<T extends AgentEventType>(event: T, handler: AgentEventHandler<T>): void

  /** Release all resources (process, connections, temp files) */
  dispose(): Promise<void>

  // ── Live intervention (optional — capability-gated) ──────────────────
  // Each session advertises support at the port level via
  // `SpawnAgentRunnerAdapter.capabilities(agentType)`. Calling an
  // unsupported method should be avoided; if called, the session MAY
  // throw or no-op. Callers (InterventionBus / spawn-agent-runner) are
  // expected to pre-check capability before dispatch.

  /** Native pause (Codex JSON-RPC or SIGSTOP). Optional. */
  pause?(): Promise<void>

  /** Native resume (Codex JSON-RPC or SIGCONT). Optional. */
  resume?(): Promise<void>

  /**
   * Send a mid-run user message to the agent without restarting.
   * Supported by Codex (persistent JSON-RPC) and Gemini ACP.
   * Claude (stateless) does not implement this — it must be handled
   * via cancel + respawn at a higher layer.
   */
  sendUserMessage?(text: string): Promise<void>
}
