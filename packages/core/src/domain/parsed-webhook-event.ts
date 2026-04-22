/**
 * ParsedWebhookEvent — tracker-agnostic domain event emitted by
 * WebhookReceiver adapters (Linear, GitHub, ...).
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 4.2 (PR4 domain promotion).
 *
 * The shape extends the minimal sketch in the design doc with an `issue`
 * envelope on `issue.transitioned` and `issue.updated`. Adapters already
 * have the full Issue in the webhook payload; carrying it on the domain
 * event avoids a round-trip back through the IssueTracker just to resolve
 * identifier / title / labels in the Orchestrator.
 *
 * Invariant: this file does not import from outside `domain/`. Validated
 * by scripts/harness/validate.sh.
 */

import type { Issue } from "./models"
import type { IssueStateType } from "./ports/tracker"

/** Kind discriminant for the domain event union. */
export type ParsedWebhookEventKind =
  | "issue.transitioned"
  | "issue.updated"
  | "issue.deleted"
  | "issue.labeled"
  | "issue.relation_changed"

export type ParsedWebhookEvent =
  | {
      kind: "issue.transitioned"
      issueId: string
      /** Null when the tracker did not report a prior state (e.g. fresh create). */
      from: IssueStateType | null
      to: IssueStateType
      /** Full issue envelope for downstream dispatch; avoids a round-trip fetch. */
      issue: Issue
    }
  | {
      kind: "issue.updated"
      issueId: string
      changedFields: string[]
      issue: Issue
    }
  | {
      kind: "issue.deleted"
      issueId: string
    }
  | {
      kind: "issue.labeled"
      issueId: string
      label: string
      issue: Issue
    }
  | {
      kind: "issue.relation_changed"
      issueId: string
      relation: "blocked_by" | "blocks"
      relatedIssueId: string
      /** true = relation added, false = relation removed. */
      added: boolean
    }
