/**
 * Agent Runner — Manages AgentSession lifecycle for issue execution.
 */

import type { RunAttempt } from "../domain/models"
import { logger } from "../observability/logger"
import type { AgentConfig, AgentEvent, AgentSession } from "../sessions/agent-session"
import { createSession, registerBuiltinSessions } from "../sessions/session-factory"

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
  onError: (error: { code: string; message: string; recoverable: boolean }) => void
  onHeartbeat: (timestamp: string) => void
}

const MAX_OUTPUT_SNIPPET = 24

export class AgentRunnerService {
  private activeSessions = new Map<string, AgentSession>()
  private activeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private lastOutputs = new Map<string, string>()
  private sessionsRegistered = false

  async ensureRegistered(): Promise<void> {
    if (!this.sessionsRegistered) {
      await registerBuiltinSessions()
      this.sessionsRegistered = true
    }
  }

  async spawn(attempt: RunAttempt, options: RunOptions, callbacks: RunCallbacks): Promise<void> {
    await this.ensureRegistered()

    const session = createSession(options.agentType)
    this.activeSessions.set(attempt.id, session)

    // Guard against double-handling of complete/error events
    let handled = false

    const cleanup = () => {
      const timer = this.activeTimers.get(attempt.id)
      if (timer) clearTimeout(timer)
      this.activeTimers.delete(attempt.id)
      this.activeSessions.delete(attempt.id)
      this.lastOutputs.delete(attempt.id)
      session.off("complete", onComplete)
      session.off("error", onError)
    }

    const onComplete = (e: Extract<AgentEvent, { type: "complete" }>) => {
      if (handled) return
      handled = true

      const completed: RunAttempt = {
        ...attempt,
        finishedAt: new Date().toISOString(),
        exitCode: e.result.exitCode,
        agentOutput: e.result.output,
      }
      cleanup()
      callbacks.onComplete(completed)
    }

    const onError = (e: Extract<AgentEvent, { type: "error" }>) => {
      if (handled) return
      handled = true

      cleanup()
      callbacks.onError(e.error)
    }

    // Wire up events
    session.on("heartbeat", (e) => callbacks.onHeartbeat(e.timestamp))
    session.on("output", (e) => {
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
      if (handled) return
      handled = true
      cleanup()
      callbacks.onError({
        code: "CRASH",
        message: `Failed to start agent: ${err}`,
        recoverable: true,
      })
      return
    }

    logger.info("orchestrator", "Agent started", {
      issueId: attempt.issueId,
      attemptId: attempt.id,
      workspacePath: options.workspacePath,
    })

    // Fire-and-forget: execute returns when agent finishes, but we don't block spawn()
    session.execute(options.prompt).catch((err) => {
      if (handled) return
      handled = true
      cleanup()
      callbacks.onError({
        code: "CRASH",
        message: `Agent execution failed: ${err}`,
        recoverable: true,
      })
    })

    // Timeout watchdog — stored so it can be cleared on completion
    const timer = setTimeout(async () => {
      if (this.activeSessions.has(attempt.id)) {
        logger.warn("orchestrator", "Agent timed out", {
          attemptId: attempt.id,
          issueId: attempt.issueId,
          durationMs: options.timeout * 1000,
        })
        await this.kill(attempt.id)
        if (!handled) {
          handled = true
          cleanup()
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

  async kill(attemptId: string): Promise<void> {
    const session = this.activeSessions.get(attemptId)
    if (!session) return

    // Clear timeout watchdog timer
    const timer = this.activeTimers.get(attemptId)
    if (timer) clearTimeout(timer)
    this.activeTimers.delete(attemptId)

    await session.cancel()
    // Give 10 seconds for graceful shutdown, then force-kill
    const killTimer = setTimeout(async () => {
      if (session.isAlive()) {
        await session.kill()
      }
      await session.dispose()
    }, 10_000)
    // Prevent the timer from keeping the process alive
    if (killTimer && typeof killTimer === "object" && "unref" in killTimer) {
      killTimer.unref()
    }

    this.activeSessions.delete(attemptId)
  }

  async killAll(): Promise<void> {
    const ids = Array.from(this.activeSessions.keys())
    await Promise.all(ids.map((id) => this.kill(id)))
  }

  get activeCount(): number {
    return this.activeSessions.size
  }

  getLastOutput(attemptId: string): string | undefined {
    return this.lastOutputs.get(attemptId)
  }
}
