/**
 * Tracker Ports — Domain-layer interfaces for issue tracking and webhook
 * receiving. Implemented by Infrastructure adapters (Linear / GitHub / ...).
 *
 * Design: docs/plans/domain-ports-di-seam-design.md (PR1)
 *         docs/plans/v0-2-bigbang-design.md § 4.1–4.2
 *
 * No imports from outside `domain/`. Validated by scripts/harness/validate.sh.
 */

import type { Issue } from "../models"

/**
 * Canonical logical workflow states — used by the scheduler boundary.
 *
 * PR1 note: the current Orchestrator threads workflow_state UUIDs through
 * these port methods directly (see `Config.workflowStates`). The logical
 * mapping is introduced alongside the GitHub adapter (M1b), at which point
 * adapters translate logical <-> concrete state identifiers internally.
 */
export type IssueStateType = "todo" | "in_progress" | "done" | "cancelled"

/**
 * IssueTracker — read and mutate issues on an external tracker.
 *
 * PR1 preserves the current call shape (UUID-level stateIds) to keep
 * existing Orchestrator / completion-handler behavior bit-identical.
 * See PREFLIGHT in the PR description for the difference against
 * design doc § 4.1 and why PR1 wraps losslessly.
 */
export interface IssueTracker {
  /** Return all issues currently in any of the given workflow state IDs. */
  fetchIssuesByState(stateIds: string[]): Promise<Issue[]>

  /** Return label names on an issue. */
  fetchIssueLabels(issueId: string): Promise<string[]>

  /** Transition an issue to a new workflow state. */
  updateIssueState(issueId: string, stateId: string): Promise<void>

  /** Post a comment. Failures should surface as thrown errors. */
  addIssueComment(issueId: string, body: string): Promise<void>

  /** Attach a label by name, creating it on-demand if the tracker supports it. */
  addIssueLabel(issueId: string, labelName: string): Promise<void>
}

/**
 * WebhookReceiver — verify a webhook signature and parse its payload into
 * a tracker-specific event shape. Generic over the event type so the
 * Domain layer does not depend on Infrastructure-specific payload shapes.
 *
 * PR1 keeps the current `ParsedWebhookEvent` (tracker/types.ts) as the
 * concrete type argument. Domain promotion of the event union is tracked
 * for PR4 (design doc § 4.2).
 */
export interface WebhookReceiver<TEvent = unknown> {
  /** Constant-time HMAC verification. */
  verifySignature(payload: string, signature: string): Promise<boolean>

  /**
   * Parse the raw webhook body. Return `null` when the payload is a
   * well-formed event this receiver does not care about (e.g. non-issue
   * types, GitHub `ping`). Throwing is reserved for schema violations.
   */
  parseEvent(payload: string): TEvent | null
}
