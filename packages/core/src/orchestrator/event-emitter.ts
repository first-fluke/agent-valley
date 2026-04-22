/**
 * OrchestratorEventEmitter — Generic event emitter extracted from Orchestrator.
 * Used for team dashboard broadcasting and ledger bridge subscriptions.
 *
 * Live intervention (C) events are emitted by InterventionBus via the
 * Orchestrator facade:
 *   - agent.paused          { attemptId, issueKey, at }
 *   - agent.resumed         { attemptId, issueKey, at }
 *   - agent.prompt_appended { attemptId, issueKey, text (<=200 chars), at }
 *   - agent.aborted         { attemptId, issueKey, reason, at }
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 5.7.
 */

import { logger } from "../observability/logger"

export type OrchestratorEventHandler = (...args: unknown[]) => void

/** Canonical event names emitted by the orchestrator. */
export const ORCHESTRATOR_EVENTS = {
  agentStart: "agent.start",
  agentDone: "agent.done",
  agentFailed: "agent.failed",
  agentPaused: "agent.paused",
  agentResumed: "agent.resumed",
  agentPromptAppended: "agent.prompt_appended",
  agentAborted: "agent.aborted",
} as const

export class OrchestratorEventEmitter {
  private eventListeners = new Map<string, Set<OrchestratorEventHandler>>()

  on(event: string, handler: OrchestratorEventHandler): void {
    const handlers = this.eventListeners.get(event) ?? new Set()
    handlers.add(handler)
    this.eventListeners.set(event, handlers)
  }

  off(event: string, handler: OrchestratorEventHandler): void {
    this.eventListeners.get(event)?.delete(handler)
  }

  /**
   * Public emit — used by intervention bus and other Application-layer
   * collaborators to surface events onto the orchestrator's stream
   * without needing a subclass pointer.
   */
  publish(event: string, payload: Record<string, unknown>): void {
    this.emitEvent(event, payload)
  }

  protected emitEvent(event: string, payload: Record<string, unknown>): void {
    const handlers = this.eventListeners.get(event)
    if (!handlers) return
    for (const handler of handlers) {
      try {
        handler(payload)
      } catch (err) {
        logger.warn("orchestrator", `Event handler error for ${event}`, { error: String(err) })
      }
    }
  }
}
