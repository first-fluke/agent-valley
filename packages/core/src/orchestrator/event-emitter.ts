/**
 * OrchestratorEventEmitter — Generic event emitter extracted from Orchestrator.
 * Used for team dashboard broadcasting and ledger bridge subscriptions.
 */

import { logger } from "../observability/logger"

export type OrchestratorEventHandler = (...args: unknown[]) => void

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
