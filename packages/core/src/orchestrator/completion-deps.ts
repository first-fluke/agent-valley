/**
 * Shared completion dependencies.
 *
 * Kept in a leaf module so `completion-handler` and `completion-error` can both
 * depend on it without importing each other.
 */
import type { Config } from "../config/yaml-loader"
import type { Issue, RetryCategory, RunAttempt, Workspace } from "../domain/models"
import type { IssueTracker } from "../domain/ports/tracker"
import type { WorkspaceGateway } from "../domain/ports/workspace"
import type { ObservabilityHooks } from "../observability/hooks"
import type { OmaEvidenceRequest, OmaEvidenceResult } from "../oma/receipt-adapter"
import type { BudgetService } from "./budget-service"
import type { DagScheduler } from "./dag-scheduler"
import type { PersistedFinalization } from "./persistence/run-state-store"

export interface CompletionDeps {
  config: Config
  workspace: WorkspaceGateway
  tracker: IssueTracker
  dagScheduler: DagScheduler
  /** Update orchestrator state on completion/failure. Orchestrator remains sole state authority. */
  cleanupState: (issueId: string, status: "done" | "failed") => void
  saveAttempt: (workspace: Workspace, attempt: RunAttempt) => void | Promise<void>
  /** `category` (see `RetryCategory`) drives RetryQueue's per-category max-attempts policy. Defaults to "infra" when omitted. */
  addRetry: (issueId: string, attemptCount: number, error: string, category?: RetryCategory) => boolean
  emitEvent: (event: string, payload: Record<string, unknown>) => void
  fillVacantSlots: () => Promise<void>
  triggerUnblocked: (issueIds: string[]) => Promise<void>
  /** Observability hooks (OTel + Prom). Defaults to no-op when omitted. */
  observability?: ObservabilityHooks
  budget?: BudgetService
  /** Additional operator evidence gate for configured analysis tasks. */
  assessNoCodeOutcome?: (issue: Issue, attempt: RunAttempt) => Promise<boolean> | boolean
  omaEvidence?: (request: OmaEvidenceRequest) => OmaEvidenceResult | Promise<OmaEvidenceResult>
  finalizeDelivered: (record: PersistedFinalization) => Promise<void>
}
