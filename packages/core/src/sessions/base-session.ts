/**
 * BaseSession — Shared event emitter and process management for all session implementations.
 */

import type { ChildProcess } from "node:child_process"
import type {
  AgentConfig,
  AgentError,
  AgentEvent,
  AgentEventHandler,
  AgentEventType,
  AgentSession,
  RunResult,
} from "./agent-session"

/** Env vars safe to pass to agent subprocesses */
const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "NODE_ENV",
  "BUN_ENV",
]

/**
 * Per-agent env keys that must be forwarded for the agent CLI to authenticate.
 * Keyed by the literal `agentType` string each session passes to
 * `buildAgentEnv()` — this matches the config-facing vendor id used by
 * SessionFactory/config/ledger (e.g. AgySession passes "antigravity" here,
 * even though its actual CLI binary is named `agy`).
 */
const AGENT_ENV_KEYS: Record<string, string[]> = {
  codex: ["OPENAI_API_KEY"],
  claude: ["ANTHROPIC_API_KEY"],
  antigravity: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  cursor: ["CURSOR_API_KEY"],
  grok: ["XAI_API_KEY", "GROK_API_KEY"],
  // kimi primarily authenticates via ~/.kimi-code/config.toml (set by the
  // `/login` device-code flow), not env vars — these are forwarded for
  // parity/CI when present, and are harmless no-ops when absent.
  kimi: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
}

/**
 * Build a minimal env for the agent subprocess.
 * Only safe system vars + agent-specific auth keys + explicit config.env are included.
 */
export function buildAgentEnv(agentType: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}

  for (const key of SAFE_ENV_KEYS) {
    const val = process.env[key]
    if (val != null) env[key] = val
  }

  const agentKeys = AGENT_ENV_KEYS[agentType] ?? []
  for (const key of agentKeys) {
    const val = process.env[key]
    if (val != null) env[key] = val
  }

  return { ...env, ...extra }
}

/** Returns a promise that resolves when the child process exits. */
export function waitForExit(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) {
      resolve()
      return
    }
    proc.once("close", () => resolve())
  })
}

/**
 * Waits for a spawned child process to fully finish, resolving only after
 * BOTH the stdout readable stream has ended (`'end'`) AND the process
 * itself has closed (`'close'`).
 *
 * Resolving on `'close'` alone (the previous pattern duplicated across
 * claude/agy/cursor/grok-session.ts) races the final buffered `'data'`
 * chunk on a fast-exiting child: `'close'` is only *usually* ordered
 * after stdio streams finish, and short-lived processes have been
 * observed (under load, on Bun's child_process implementation) to fire
 * `'close'` before the last `'data'` chunk reaches listeners — silently
 * truncating output or resolving before parsing completes.
 *
 * `graceMs` bounds the wait in case `'end'` never fires (e.g. a pipe
 * destroyed by SIGKILL without a clean EOF) so this can never hang
 * forever once the process has closed.
 */
export function waitForStreamCompletion(proc: ChildProcess, graceMs = 250): Promise<{ exitCode: number | null }> {
  return new Promise((resolve) => {
    if (!proc.stdout) {
      proc.once("close", (code) => resolve({ exitCode: code }))
      return
    }

    let settled = false
    let closeCode: number | null = null
    let closed = false
    let stdoutDone = false
    let graceTimer: ReturnType<typeof setTimeout> | null = null

    const finish = () => {
      if (settled) return
      settled = true
      if (graceTimer) clearTimeout(graceTimer)
      resolve({ exitCode: closeCode })
    }

    const maybeFinish = () => {
      if (closed && stdoutDone) finish()
    }

    proc.stdout.once("end", () => {
      stdoutDone = true
      maybeFinish()
    })

    proc.stdout.once("error", () => {
      stdoutDone = true
      maybeFinish()
    })

    proc.once("close", (code) => {
      closed = true
      closeCode = code
      if (stdoutDone) {
        finish()
        return
      }
      // stdout hasn't signaled 'end' yet — give it a short grace window to
      // flush any buffered 'data' before giving up and resolving anyway.
      graceTimer = setTimeout(finish, graceMs)
    })
  })
}

export abstract class BaseSession implements AgentSession {
  protected config: AgentConfig | null = null
  protected startedAt: number = 0
  private _process: ChildProcess | null = null

  /**
   * Backed by `_process` so every subclass's `this.process = spawn(...)`
   * assignment transparently emits a `spawned` event with the real OS
   * pid — no subclass changes required. Consumers (AgentRunnerService)
   * listen for `spawned` to capture the pid for crash-recovery
   * persistence (`PersistedAttempt.pid`).
   */
  protected get process(): ChildProcess | null {
    return this._process
  }

  protected set process(proc: ChildProcess | null) {
    this._process = proc
    if (proc) {
      this.emit({ type: "spawned", pid: proc.pid })
    }
  }

  /** OS process id of the spawned child, when known. */
  get pid(): number | undefined {
    return this._process?.pid
  }

  abstract start(config: AgentConfig): Promise<void>
  abstract execute(prompt: string): Promise<void>

  private listeners = new Map<string, Set<AgentEventHandler<AgentEventType>>>()

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
    this.listeners.get(event)?.add(handler as unknown as AgentEventHandler<AgentEventType>)
  }

  off<T extends AgentEventType>(event: T, handler: AgentEventHandler<T>): void {
    this.listeners.get(event)?.delete(handler as unknown as AgentEventHandler<AgentEventType>)
  }

  protected emit(event: AgentEvent): void {
    const handlers = this.listeners.get(event.type)
    if (handlers) {
      for (const handler of handlers) {
        handler(event)
      }
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
      await waitForExit(this.process)
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
