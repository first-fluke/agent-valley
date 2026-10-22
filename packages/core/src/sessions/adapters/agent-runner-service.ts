/**
 * Agent Runner — Manages AgentSession lifecycle for issue execution.
 */

import { AsyncLocalStorage } from "node:async_hooks"
import type { RunAttempt } from "../../domain/models"
import { logger } from "../../observability/logger"
import type { AgentConfig, AgentEvent, AgentSession } from "../agent-session"
import { createSession, registerBuiltinSessions } from "../session-factory"

export interface RunOptions {
  agentType: string
  model?: string
  timeout: number
  prompt: string
  workspacePath: string
  env?: Record<string, string>
}

export interface RunCallbacks {
  onComplete: (result: RunAttempt) => void
  onError: (error: {
    code: string
    message: string
    recoverable: boolean
    exitCode?: number
    tokenUsage?: RunAttempt["tokenUsage"]
  }) => void
  onHeartbeat: (timestamp: string) => void
  /**
   * Fired once the session's OS child process is actually spawned (see
   * `AgentSession.pid` / the `spawned` event). Optional — callers that
   * don't need the pid (most tests) can omit it. Used by orchestrator-core
   * to persist a real pid instead of `null`, so crash recovery can
   * probe liveness on restart (see `persistence/recovery.ts`).
   */
  onSpawned?: (pid: number | undefined) => void
  onOutput?: (text: string) => void
}

const MAX_OUTPUT_SNIPPET = 24

export class AgentRunnerService {
  private activeSessions = new Map<string, AgentSession>()
  private activeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private lastOutputs = new Map<string, string>()
  private activeAgentTypes = new Map<string, string>()
  private cancelAttempts = new Map<string, () => void>()
  private pendingDisposals = new Set<Promise<void>>()
  private pendingStarts = new Map<string, Promise<void>>()
  private pendingExecutions = new Map<string, Promise<void>>()
  private attemptDisposals = new Map<string, Set<Promise<void>>>()
  private cleanupFailures = new Map<string, Error>()
  private startingDisposals = new Map<string, AgentSession>()
  private pendingCallbacks = new Set<Promise<void>>()
  private callbackContext = new AsyncLocalStorage<boolean>()
  private activeStops = new Map<string, Promise<void>>()
  private sessionsRegistered = false

  /** Read-only accessor used by InterventionBus (C). */
  getSession(attemptId: string): AgentSession | undefined {
    return this.activeSessions.get(attemptId)
  }

  /** Read-only accessor for agent type used by InterventionBus (C). */
  getAgentType(attemptId: string): string | undefined {
    return this.activeAgentTypes.get(attemptId)
  }

  async ensureRegistered(): Promise<void> {
    if (!this.sessionsRegistered) {
      await registerBuiltinSessions()
      this.sessionsRegistered = true
    }
  }

  spawn(attempt: RunAttempt, options: RunOptions, handlers: RunCallbacks): Promise<void> {
    const starting = this.startAttempt(attempt, options, handlers)
    this.pendingStarts.set(attempt.id, starting)
    const forget = () => {
      if (this.pendingStarts.get(attempt.id) === starting) this.pendingStarts.delete(attempt.id)
      const disposed = this.startingDisposals.get(attempt.id)
      if (disposed) {
        this.recordCleanupState(disposed, attempt.id)
        this.startingDisposals.delete(attempt.id)
      }
    }
    void starting.then(forget, forget)
    return starting
  }

  /** Join only this attempt, including a process that starts after cancellation. */
  async waitForAttempt(attemptId: string): Promise<void> {
    await this.pendingStarts.get(attemptId)
    await this.activeStops.get(attemptId)
    const executing = this.pendingExecutions.get(attemptId)
    if (this.cleanupFailures.has(attemptId) && executing) {
      // A failed signal can race a natural exit. Let execute() join and retry
      // disposal; a still-live or still-denied execution remains uncertain.
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          executing,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 250)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    } else await executing
    while (this.attemptDisposals.has(attemptId)) await Promise.all(this.attemptDisposals.get(attemptId) ?? [])
    const failure = this.cleanupFailures.get(attemptId)
    if (failure) throw failure
    await executing
  }

  private async startAttempt(attempt: RunAttempt, options: RunOptions, handlers: RunCallbacks): Promise<void> {
    const callbacks: RunCallbacks = {
      ...handlers,
      onComplete: (result) => this.dispatchCallback(attempt.id, () => handlers.onComplete(result)),
      onError: (error) => this.dispatchCallback(attempt.id, () => handlers.onError(error)),
    }
    let cancelledBeforeStart = false
    this.cancelAttempts.set(attempt.id, () => {
      cancelledBeforeStart = true
    })
    let session: AgentSession
    try {
      await this.ensureRegistered()
      if (cancelledBeforeStart) {
        this.cancelAttempts.delete(attempt.id)
        return
      }
      session = createSession(options.agentType)
    } catch (err) {
      this.cancelAttempts.delete(attempt.id)
      if (cancelledBeforeStart) return
      callbacks.onError({ code: "CRASH", message: `Failed to initialize agent: ${err}`, recoverable: false })
      return
    }
    this.activeSessions.set(attempt.id, session)
    this.activeAgentTypes.set(attempt.id, options.agentType)

    // Guard against double-handling of complete/error events
    let handled = false

    const cleanup = (dispose = true) => {
      const timer = this.activeTimers.get(attempt.id)
      if (timer) clearTimeout(timer)
      this.activeTimers.delete(attempt.id)
      this.activeSessions.delete(attempt.id)
      this.activeAgentTypes.delete(attempt.id)
      this.lastOutputs.delete(attempt.id)
      this.cancelAttempts.delete(attempt.id)
      session.off("complete", onComplete)
      session.off("error", onError)
      if (dispose) void this.disposeSession(session, attempt.id)
    }

    const onComplete = (e: Extract<AgentEvent, { type: "complete" }>) => {
      if (handled) return
      handled = true

      const completed: RunAttempt = {
        ...attempt,
        finishedAt: new Date().toISOString(),
        exitCode: e.result.exitCode,
        agentOutput: e.result.output,
        tokenUsage: e.result.tokenUsage,
      }
      cleanup()
      if (e.result.exitCode !== 0) {
        callbacks.onError({
          code: "CRASH",
          message: `Agent exited with code ${e.result.exitCode}: ${e.result.output.slice(-MAX_OUTPUT_SNIPPET)}`,
          recoverable: true,
          exitCode: e.result.exitCode,
          tokenUsage: e.result.tokenUsage,
        })
      } else {
        callbacks.onComplete(completed)
      }
    }

    const onError = (e: Extract<AgentEvent, { type: "error" }>) => {
      if (handled) return
      handled = true

      cleanup()
      callbacks.onError(e.error)
    }
    this.cancelAttempts.set(attempt.id, () => {
      handled = true
      cleanup(false)
    })

    // Wire up events
    session.on("spawned", (e) => {
      if (!handled) callbacks.onSpawned?.(e.pid)
    })
    session.on("heartbeat", (e) => {
      if (!handled) callbacks.onHeartbeat(e.timestamp)
    })
    session.on("output", (e) => {
      if (handled) return
      callbacks.onOutput?.(e.chunk)
      const snippet = e.chunk.trim().replace(/\s+/g, " ").slice(-MAX_OUTPUT_SNIPPET)
      if (snippet) this.lastOutputs.set(attempt.id, snippet)
    })
    session.on("complete", onComplete)
    session.on("error", onError)

    // Start session
    const config: AgentConfig = {
      type: options.agentType,
      model: options.model,
      timeout: options.timeout,
      workspacePath: options.workspacePath,
      env: options.env,
    }

    try {
      await session.start(config)
    } catch (err) {
      if (handled) {
        await this.disposeSession(session, attempt.id)
        return
      }
      handled = true
      cleanup()
      callbacks.onError({
        code: "CRASH",
        message: `Failed to start agent: ${err}`,
        recoverable: true,
      })
      return
    }
    if (handled) {
      await this.disposeSession(session, attempt.id)
      return
    }

    logger.info("orchestrator", "Agent started", {
      issueId: attempt.issueId,
      attemptId: attempt.id,
      workspacePath: options.workspacePath,
    })

    // Fire-and-forget: execute returns when agent finishes, but we don't block spawn()
    const executing = session
      .execute(options.prompt)
      .catch((err) => {
        if (handled) return
        handled = true
        cleanup()
        callbacks.onError({
          code: "CRASH",
          message: `Agent execution failed: ${err}`,
          recoverable: true,
        })
      })
      .finally(async () => {
        // execute() can await preparation before creating a process. Cancellation
        // must also dispose a process that appears after its first stop request.
        if (handled) {
          await this.activeStops.get(attempt.id)
          await Promise.all(this.attemptDisposals.get(attempt.id) ?? [])
          if (session.isAlive() || this.cleanupFailures.has(attempt.id)) await this.disposeSession(session, attempt.id)
        }
      })
    this.pendingExecutions.set(attempt.id, executing)
    const forgetExecution = () => {
      if (this.pendingExecutions.get(attempt.id) === executing) this.pendingExecutions.delete(attempt.id)
    }
    void executing.then(forgetExecution, forgetExecution)

    if (handled) return
    // Timeout watchdog — stored so it can be cleared on completion
    const timer = setTimeout(async () => {
      if (this.activeSessions.has(attempt.id)) {
        logger.warn("orchestrator", "Agent timed out", {
          attemptId: attempt.id,
          issueId: attempt.issueId,
          durationMs: options.timeout * 1000,
        })
        if (!handled) {
          handled = true
          await this.kill(attempt.id)
          callbacks.onError({
            code: "TIMEOUT",
            message: `Agent timed out after ${options.timeout}s`,
            recoverable: true,
          })
        }
      }
    }, options.timeout * 1000)
    this.activeTimers.set(attempt.id, timer)
  }

  kill(attemptId: string): Promise<void> {
    const activeStop = this.activeStops.get(attemptId)
    if (activeStop) return activeStop
    let resolveStop!: () => void
    let rejectStop!: (error: unknown) => void
    const stopped = new Promise<void>((resolve, reject) => {
      resolveStop = resolve
      rejectStop = reject
    })
    // Register before cancellation: its events can synchronously trigger
    // another killAll after the active session entry has been removed.
    this.activeStops.set(attemptId, stopped)
    void this.stopAttempt(attemptId).then(resolveStop, rejectStop)
    const forget = () => this.activeStops.delete(attemptId)
    void stopped.then(forget, forget)
    return stopped
  }

  private async stopAttempt(attemptId: string): Promise<void> {
    const session = this.activeSessions.get(attemptId)

    // Cancellation can synchronously emit complete/error. Suppress delivery and
    // retry callbacks before requesting cancellation, including during start().
    this.cancelAttempts.get(attemptId)?.()
    this.cancelAttempts.delete(attemptId)
    if (!session) return

    let finish: (() => void) | undefined
    const stopped = new Promise<void>((resolve) => {
      finish = resolve
    })
    let stopping: Promise<void> | undefined
    const forceStop = (): Promise<void> => {
      stopping ??= (async () => {
        try {
          if (session.isAlive()) await session.kill()
        } catch (err) {
          logger.warn("orchestrator", "Failed to kill agent; disposing its session", { attemptId, error: String(err) })
        } finally {
          await this.disposeSession(session, attemptId)
          finish?.()
        }
      })()
      return stopping
    }
    // Install the watchdog before cancel(), which may reject or never resolve.
    const killTimer = setTimeout(() => {
      void forceStop()
    }, 10_000)
    try {
      await Promise.race([session.cancel(), stopped])
      await forceStop()
    } catch (err) {
      logger.warn("orchestrator", "Agent cancellation failed; forcing shutdown", { attemptId, error: String(err) })
      await forceStop()
    }
    await stopped
    clearTimeout(killTimer)
  }

  private disposeSession(session: AgentSession, attemptId: string): Promise<void> {
    const disposal = (async () => {
      try {
        await session.dispose()
        this.cleanupFailures.delete(attemptId)
        // A cancelled start can create its process after an earlier disposal.
        // Inspect it once start has joined, after the final disposal has run.
        if (this.pendingStarts.has(attemptId)) this.startingDisposals.set(attemptId, session)
        else this.recordCleanupState(session, attemptId)
      } catch (err) {
        this.cleanupFailures.set(attemptId, err instanceof Error ? err : new Error(String(err)))
        logger.error("orchestrator", "Failed to dispose agent session", { attemptId, error: String(err) })
      }
    })()
    this.pendingDisposals.add(disposal)
    const disposals = this.attemptDisposals.get(attemptId) ?? new Set<Promise<void>>()
    disposals.add(disposal)
    this.attemptDisposals.set(attemptId, disposals)
    void disposal.finally(() => {
      this.pendingDisposals.delete(disposal)
      disposals.delete(disposal)
      if (disposals.size === 0) this.attemptDisposals.delete(attemptId)
    })
    return disposal
  }

  private recordCleanupState(session: AgentSession, attemptId: string): void {
    try {
      if (session.isAlive())
        throw new Error("Agent session remains active after disposal. Inspect and stop it before resuming.")
    } catch (error) {
      this.cleanupFailures.set(attemptId, error instanceof Error ? error : new Error(String(error)))
    }
  }

  private dispatchCallback(attemptId: string, callback: () => unknown): void {
    let finish: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    this.pendingCallbacks.add(pending)
    const settle = () => {
      this.pendingCallbacks.delete(pending)
      finish?.()
    }
    const fail = (error: unknown) => {
      logger.error("orchestrator", "Agent result handler failed", { attemptId, error: String(error) })
      settle()
    }
    try {
      Promise.resolve(this.callbackContext.run(true, callback)).then(settle, fail)
    } catch (error) {
      fail(error)
    }
  }

  async killAll(): Promise<void> {
    do {
      const ids = [...new Set([...this.cancelAttempts.keys(), ...this.activeStops.keys()])]
      await Promise.all(ids.map((id) => this.kill(id)))
      await Promise.all(this.pendingDisposals)
      // A callback may itself request shutdown. Its caller must be allowed to
      // finish; an external shutdown still waits for the complete handler chain.
      if (this.callbackContext.getStore()) return
      while (this.pendingCallbacks.size > 0) await Promise.all(this.pendingCallbacks)
      // A result handler may create another session while it is being drained.
    } while (this.cancelAttempts.size > 0 || this.activeStops.size > 0 || this.pendingDisposals.size > 0)
  }

  get activeCount(): number {
    return this.activeSessions.size
  }

  getLastOutput(attemptId: string): string | undefined {
    return this.lastOutputs.get(attemptId)
  }
}
