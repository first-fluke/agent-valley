/**
 * BaseSession — Shared event emitter and process management for all session implementations.
 */

import type {
  AgentConfig,
  AgentEvent,
  AgentEventHandler,
  AgentEventType,
  AgentSession,
  AgentError,
  RunResult,
} from "./agent-session"
import type { Subprocess, FileSink } from "bun"

/** Env vars safe to pass to agent subprocesses */
const SAFE_ENV_KEYS = [
  "PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR",
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
  "NODE_ENV", "BUN_ENV",
]

/** Per-agent env keys that must be forwarded for the agent CLI to authenticate */
const AGENT_ENV_KEYS: Record<string, string[]> = {
  codex:  ["OPENAI_API_KEY"],
  claude: ["ANTHROPIC_API_KEY"],
  gemini: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
}

/**
 * Build a minimal env for the agent subprocess.
 * Only safe system vars + agent-specific auth keys + explicit config.env are included.
 */
export function buildAgentEnv(
  agentType: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {}

  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] != null) env[key] = process.env[key]!
  }

  const agentKeys = AGENT_ENV_KEYS[agentType] ?? []
  for (const key of agentKeys) {
    if (process.env[key] != null) env[key] = process.env[key]!
  }

  return { ...env, ...extra }
}

export abstract class BaseSession implements AgentSession {
  protected config: AgentConfig | null = null
  protected process: Subprocess | null = null
  protected startedAt: number = 0

  private listeners = new Map<string, Set<AgentEventHandler<any>>>()

  // ── Abstract methods (each session must implement) ────────────────────────

  abstract start(config: AgentConfig): Promise<void>
  abstract execute(prompt: string): Promise<void>

  // ── Pre-start guard ─────────────────────────────────────────────────────

  protected assertStarted(): boolean {
    if (!this.process || !this.isAlive()) {
      this.emitError("CRASH", "execute() called before start() or after process died", false)
      return false
    }
    return true
  }

  // ── Event emitter ─────────────────────────────────────────────────────────

  on<T extends AgentEventType>(event: T, handler: AgentEventHandler<T>): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(handler)
  }

  off<T extends AgentEventType>(event: T, handler: AgentEventHandler<T>): void {
    this.listeners.get(event)?.delete(handler)
  }

  protected emit(event: AgentEvent): void {
    const handlers = this.listeners.get(event.type)
    if (handlers) {
      Array.from(handlers).forEach(handler => handler(event))
    }
  }

  // ── Process management ────────────────────────────────────────────────────

  async cancel(): Promise<void> {
    if (this.process && this.isAlive()) {
      this.process.kill("SIGTERM")
    }
  }

  async kill(): Promise<void> {
    if (this.process && this.isAlive()) {
      this.process.kill("SIGKILL")
    }
  }

  isAlive(): boolean {
    if (!this.process) return false
    return this.process.exitCode === null
  }

  async dispose(): Promise<void> {
    if (this.process && this.isAlive()) {
      this.process.kill("SIGKILL")
      await this.process.exited
    }
    this.listeners.clear()
    this.process = null
    this.config = null
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  protected elapsedMs(): number {
    return Date.now() - this.startedAt
  }

  protected emitError(code: AgentError["code"], message: string, recoverable: boolean): void {
    this.emit({
      type: "error",
      error: {
        code,
        message,
        exitCode: this.process?.exitCode ?? undefined,
        recoverable,
      },
    })
  }

  protected buildRunResult(output: string, filesChanged: string[] = []): RunResult {
    const maxOutput = 10 * 1024
    return {
      exitCode: this.process?.exitCode ?? -1,
      output: output.length > maxOutput ? output.slice(0, maxOutput) : output,
      durationMs: this.elapsedMs(),
      filesChanged,
    }
  }
}
