import type { ActiveWorkspace } from "@/features/office/types/agent"

/**
 * `ActiveWorkspace` (features/office/types/agent.ts) does not declare
 * `attemptId` / `agentType`, but the orchestrator runtime already emits
 * them on every SSE `state` payload — see
 * `packages/core/src/orchestrator/helpers.ts` (`buildOrchestratorStatus`):
 * "Exposed so the dashboard InterventionPanel can target the running
 * session without an extra /api/status round-trip."
 *
 * This is a local, additive type extension (not an edit to the shared
 * `office` feature type) so the orchestrator feature can consume the
 * fields it needs without crossing feature ownership boundaries.
 * TODO(oma-deferred): fold `attemptId`/`agentType` into the canonical
 * `ActiveWorkspace` type once the `office` feature owner updates it.
 */
export interface RunningWorkspace extends ActiveWorkspace {
  attemptId?: string
  agentType?: string
}
