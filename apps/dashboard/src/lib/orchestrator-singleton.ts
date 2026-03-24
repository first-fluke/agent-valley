/**
 * Orchestrator singleton — initialized once via instrumentation.ts.
 *
 * Uses globalThis to ensure the instance is shared across module boundaries
 * (instrumentation.ts and Route Handlers may use different module instances
 * due to Turbopack bundling).
 */

export interface OrchestratorInstance {
  getStatus: () => Record<string, unknown>
  handleWebhook: (payload: string, signature: string) => Promise<{ status: number; body: string }>
  stop: () => Promise<void>
  on: (event: string, handler: (...args: unknown[]) => void) => void
  off: (event: string, handler: (...args: unknown[]) => void) => void
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
