/**
 * InterventionBus — Application-layer mediator that carries live
 * intervention commands (pause / resume / append_prompt / abort) from
 * the dashboard to the correct AgentSession.
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 3.1 (C), § 5.7, § 6.3
 * (E11–E15), § 6.9 (보안).
 *
 * Invariants:
 *   - FIFO per attemptId. A command is only applied after the previous
 *     one for the same attempt completes. Last writer wins.
 *   - No direct runtime-state mutation. The bus never touches
 *     OrchestratorRuntimeState — it only talks to the AgentRunnerService
 *     (native pause / resume / sendUserMessage) and the Port's
 *     capability table.
 *   - Errors are returned as `InterventionResult`, never thrown. The
 *     HTTP route maps results to status codes.
 *
 * Supported command → session method matrix:
 *   pause         → session.pause()           (codex only; POSIX only)
 *   resume        → session.resume()          (codex only; POSIX only)
 *   append_prompt → session.sendUserMessage() native; for claude/gemini-CLI
 *                   we cancel + request a retry from the orchestrator.
 *   abort         → service.kill(attemptId)
 */

import { sanitizeIssueBody } from "../config/workflow-loader"
import type { InterventionCapability, InterventionCommand } from "../domain/ports/agent-runner"
import type { logger as loggerInstance } from "../observability/logger"
import type { SpawnAgentRunnerAdapter } from "../sessions/adapters/spawn-agent-runner"
import type { AgentSession } from "../sessions/agent-session"
import type { AgentRunnerService } from "./agent-runner"

type Logger = typeof loggerInstance

/** Telemetry callback fired by the bus when a command is successfully applied. */
export interface InterventionTelemetry {
  onPaused?(ctx: InterventionContext): void
  onResumed?(ctx: InterventionContext): void
  onPromptAppended?(ctx: InterventionContext & { text: string }): void
  onAborted?(ctx: InterventionContext & { reason: string }): void
}

export interface InterventionContext {
  attemptId: string
  issueKey?: string
  agentType: string
  at: string
}

/**
 * Attempt metadata the bus needs but cannot infer from the runner.
 * Populated by the Orchestrator at spawn time.
 */
export interface InterventionAttemptMeta {
  attemptId: string
  issueKey: string
  agentType: string
  /** Optional hook invoked for append_prompt on stateless agents (claude / gemini-CLI). */
  requestRetry?: (text: string) => Promise<void>
}

export interface InterventionBusDeps {
  runner: AgentRunnerService
  port: Pick<SpawnAgentRunnerAdapter, "capabilities">
  logger: Pick<Logger, "info" | "warn" | "error">
  telemetry?: InterventionTelemetry
}

export type InterventionResult =
  | { ok: true }
  | { ok: false; reason: "unsupported" | "terminated" | "unknown_attempt" | "invalid"; message: string }

/** Maximum append_prompt text length (mirrors workflow-loader truncation). */
const MAX_APPEND_PROMPT_LENGTH = 10_000

export class InterventionBus {
  private readonly runner: AgentRunnerService
  private readonly port: Pick<SpawnAgentRunnerAdapter, "capabilities">
  private readonly logger: Pick<Logger, "info" | "warn" | "error">
  private readonly telemetry: InterventionTelemetry
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly attempts = new Map<string, InterventionAttemptMeta>()

  constructor(deps: InterventionBusDeps) {
    this.runner = deps.runner
    this.port = deps.port
    this.logger = deps.logger
    this.telemetry = deps.telemetry ?? {}
  }

  /** Register per-attempt metadata at spawn time. */
  registerAttempt(meta: InterventionAttemptMeta): void {
    this.attempts.set(meta.attemptId, meta)
  }

  /** Clear per-attempt metadata on completion / cancellation. */
  unregisterAttempt(attemptId: string): void {
    this.attempts.delete(attemptId)
    this.queues.delete(attemptId)
  }

  /** Inspect currently-registered attempt ids (test hook). */
  listAttempts(): string[] {
    return [...this.attempts.keys()]
  }

  /**
   * Send a command to the named attempt. Commands are processed FIFO per
   * attempt — concurrent callers are serialized, last writer wins
   * (§6.3 E15). Returns a `InterventionResult` instead of throwing so
   * the HTTP surface can return actionable 4xx codes.
   */
  async send(attemptId: string, cmd: InterventionCommand): Promise<InterventionResult> {
    if (!attemptId) {
      return {
        ok: false,
        reason: "invalid",
        message:
          "InterventionBus.send: attemptId is required.\n  Fix: include attemptId in the POST body to /api/intervention.",
      }
    }
    const meta = this.attempts.get(attemptId)
    if (!meta) {
      return {
        ok: false,
        reason: "unknown_attempt",
        message:
          `InterventionBus.send: no active attempt for attemptId "${attemptId}".\n` +
          "  Fix: refresh the dashboard to pick up currently-active attempt ids.",
      }
    }

    const session = this.runner.getSession(attemptId)
    if (!session || !session.isAlive()) {
      return {
        ok: false,
        reason: "terminated",
        message:
          `InterventionBus.send: attempt "${attemptId}" is already terminated.\n` +
          "  Fix: re-queue the issue via the tracker to start a new attempt.",
      }
    }

    const caps = this.port.capabilities(meta.agentType)
    if (!caps.includes(cmd.kind as InterventionCapability)) {
      return {
        ok: false,
        reason: "unsupported",
        message:
          `InterventionBus.send: agent "${meta.agentType}" does not support command "${cmd.kind}".\n` +
          `  Fix: pre-check capabilities(${JSON.stringify(meta.agentType)}) before dispatching; disable the UI control when absent.`,
      }
    }

    const runCmd = async (): Promise<InterventionResult> => {
      try {
        return await this.dispatch(meta, session, cmd)
      } catch (err) {
        this.logger.error("intervention", `Command "${cmd.kind}" failed for ${attemptId}`, {
          error: String(err),
          agentType: meta.agentType,
        })
        return {
          ok: false,
          reason: "invalid",
          message: `InterventionBus.send: command "${cmd.kind}" threw — ${String(err)}.`,
        }
      }
    }

    // FIFO queue per attemptId: chain onto the previous promise if any.
    const prev = this.queues.get(attemptId) ?? Promise.resolve()
    const next = prev.then(runCmd, runCmd)
    // Store the chained promise so subsequent callers wait on it.
    this.queues.set(attemptId, next)
    const result = await next
    // Clean up the pointer only if we are still the tail.
    if (this.queues.get(attemptId) === next) {
      this.queues.delete(attemptId)
    }
    return result
  }

  // ── Dispatch ──────────────────────────────────────────────────────────

  private async dispatch(
    meta: InterventionAttemptMeta,
    session: AgentSession,
    cmd: InterventionCommand,
  ): Promise<InterventionResult> {
    const ctx: InterventionContext = {
      attemptId: meta.attemptId,
      issueKey: meta.issueKey,
      agentType: meta.agentType,
      at: new Date().toISOString(),
    }

    if (cmd.kind === "pause") {
      if (typeof session.pause !== "function") {
        return {
          ok: false,
          reason: "unsupported",
          message:
            `InterventionBus.pause: session for agent "${meta.agentType}" does not implement pause().\n` +
            "  Fix: extend the session class with pause()/resume() or remove the capability advertisement.",
        }
      }
      await session.pause()
      this.logger.info("intervention", `Paused attempt ${meta.attemptId}`, { agentType: meta.agentType })
      this.telemetry.onPaused?.(ctx)
      return { ok: true }
    }

    if (cmd.kind === "resume") {
      if (typeof session.resume !== "function") {
        return {
          ok: false,
          reason: "unsupported",
          message:
            `InterventionBus.resume: session for agent "${meta.agentType}" does not implement resume().\n` +
            "  Fix: extend the session class with pause()/resume() or remove the capability advertisement.",
        }
      }
      await session.resume()
      this.logger.info("intervention", `Resumed attempt ${meta.attemptId}`, { agentType: meta.agentType })
      this.telemetry.onResumed?.(ctx)
      return { ok: true }
    }

    if (cmd.kind === "append_prompt") {
      const rawText = typeof cmd.text === "string" ? cmd.text : ""
      if (!rawText.trim()) {
        return {
          ok: false,
          reason: "invalid",
          message: "InterventionBus.append_prompt: text is empty.\n  Fix: supply non-empty text in the POST body.",
        }
      }
      const sanitized = sanitizeIssueBody(rawText).slice(0, MAX_APPEND_PROMPT_LENGTH)
      if (typeof session.sendUserMessage === "function") {
        try {
          await session.sendUserMessage(sanitized)
          this.logger.info("intervention", `Appended prompt to ${meta.attemptId} (native)`, {
            agentType: meta.agentType,
          })
          this.telemetry.onPromptAppended?.({ ...ctx, text: truncate(sanitized) })
          return { ok: true }
        } catch (err) {
          // Fall through to cancel+respawn if the native path is unavailable
          // (e.g. GeminiSession in CLI fallback mode).
          this.logger.warn(
            "intervention",
            `Native sendUserMessage failed for ${meta.attemptId}; falling back to cancel+respawn`,
            { error: String(err), agentType: meta.agentType },
          )
        }
      }
      // Fallback: cancel + request retry with the merged text.
      if (!meta.requestRetry) {
        return {
          ok: false,
          reason: "unsupported",
          message:
            `InterventionBus.append_prompt: agent "${meta.agentType}" is stateless and no requestRetry hook was registered.\n` +
            "  Fix: pass requestRetry on InterventionBus.registerAttempt() so the orchestrator can re-queue the issue.",
        }
      }
      await session.cancel()
      await meta.requestRetry(sanitized)
      this.logger.info("intervention", `Appended prompt via cancel+retry for ${meta.attemptId}`, {
        agentType: meta.agentType,
      })
      this.telemetry.onPromptAppended?.({ ...ctx, text: truncate(sanitized) })
      return { ok: true }
    }

    if (cmd.kind === "abort") {
      const reason = typeof cmd.reason === "string" ? cmd.reason : "operator_requested"
      await this.runner.kill(meta.attemptId)
      this.logger.info("intervention", `Aborted attempt ${meta.attemptId}`, {
        agentType: meta.agentType,
        reason,
      })
      this.telemetry.onAborted?.({ ...ctx, reason })
      return { ok: true }
    }

    return {
      ok: false,
      reason: "invalid",
      message:
        `InterventionBus.dispatch: unknown command kind "${(cmd as { kind: string }).kind}".\n` +
        "  Fix: send one of pause | resume | append_prompt | abort.",
    }
  }
}

function truncate(s: string): string {
  return s.length > 200 ? `${s.slice(0, 200)}...` : s
}
