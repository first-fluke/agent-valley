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
  handleWebhook: (payload: string, signature: string) => Promise<{ status: number; body: string }>
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
  // biome-ignore lint: global augmentation for singleton
  var __agent_valley_orchestrator__: OrchestratorInstance | undefined
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
