/**
 * Orchestrator singleton — initialized once via instrumentation.ts.
 *
 * Uses globalThis to ensure the instance is shared across module boundaries
 * (instrumentation.ts and Route Handlers may use different module instances
 * due to Turbopack bundling).
 */

import type { InterventionBus } from "@agent-valley/core/orchestrator/intervention-bus"

export interface OrchestratorInstance {
  getStatus: () => Record<string, unknown>
  handleWebhook: (payload: string, signature: string, deliveryId?: string) => Promise<{ status: number; body: string }>
  stop: () => Promise<void>
  on: (event: string, handler: (...args: unknown[]) => void) => void
  off: (event: string, handler: (...args: unknown[]) => void) => void
  /**
   * Live intervention bus (C) — routes dashboard commands to the active
   * session. Optional in the interface so test fakes that don't exercise
   * the /api/intervention route don't need to stub it out.
   */
  intervention?: InterventionBus
}

declare global {
  var __agent_valley_orchestrator__: OrchestratorInstance | undefined
  var __agent_valley_initialization__: Promise<void> | undefined
}

/** Serialize startup and stop the previous scheduler before starting its replacement. */
export function initializeOrchestrator(create: () => Promise<OrchestratorInstance>): Promise<void> {
  if (globalThis.__agent_valley_initialization__) return globalThis.__agent_valley_initialization__
  const pending = Promise.resolve()
    .then(async () => {
      const previous = getOrchestrator()
      if (previous) await previous.stop()
      globalThis.__agent_valley_orchestrator__ = undefined
      globalThis.__agent_valley_orchestrator__ = await create()
    })
    .finally(() => {
      globalThis.__agent_valley_initialization__ = undefined
    })
  globalThis.__agent_valley_initialization__ = pending
  return pending
}

export async function setOrchestrator(instance: OrchestratorInstance) {
  // Stop previous instance on hot reload to prevent orphaned agent processes and timers
  const prev = globalThis.__agent_valley_orchestrator__
  if (prev) {
    await prev.stop()
  }
  globalThis.__agent_valley_orchestrator__ = instance
}

export function getOrchestrator(): OrchestratorInstance | null {
  return globalThis.__agent_valley_orchestrator__ ?? null
}
