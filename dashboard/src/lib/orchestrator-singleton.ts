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
}

declare global {
  // biome-ignore lint: global augmentation for singleton
  var __composer_orchestrator__: OrchestratorInstance | undefined
}

export function setOrchestrator(instance: OrchestratorInstance) {
  globalThis.__composer_orchestrator__ = instance
}

export function getOrchestrator(): OrchestratorInstance | null {
  return globalThis.__composer_orchestrator__ ?? null
}
