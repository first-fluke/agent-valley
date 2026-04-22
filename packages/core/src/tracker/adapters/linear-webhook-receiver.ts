/**
 * LinearWebhookReceiver — Infrastructure adapter implementing the domain
 * `WebhookReceiver<ParsedWebhookEvent>` port against Linear's HMAC-SHA256
 * webhook contract.
 *
 * PR4: the adapter now produces the tracker-agnostic domain event
 * (`domain/parsed-webhook-event.ts`) rather than Linear-specific shapes.
 * Linear workflow-state UUIDs are mapped to the canonical `IssueStateType`
 * using the `workflowStates` table passed in at construction time.
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 4.2 / § 5.5 (PR4).
 */

import type { ParsedWebhookEvent } from "../../domain/parsed-webhook-event"
import type { IssueStateType, WebhookReceiver } from "../../domain/ports/tracker"
import type { LinearParsedWebhookEvent } from "../types"
import { parseWebhookEvent, verifyWebhookSignature } from "../webhook-handler"

/**
 * UUID-based workflow state identifiers from `valley.yaml`. The receiver
 * uses this table to translate Linear state IDs into logical states on
 * every incoming webhook.
 */
export interface LinearWebhookWorkflowStates {
  todo: string
  inProgress: string
  done: string
  cancelled: string
}

export interface LinearWebhookReceiverConfig {
  /** Webhook signing secret from Linear (matches Config.linearWebhookSecret). */
  secret: string
  /**
   * Optional: Linear workflow-state UUID table. When provided, the
   * adapter translates state IDs to IssueStateType on each event. When
   * omitted, the adapter emits `issue.updated` for every issue event so
   * the Orchestrator can still observe activity but will not route by
   * logical state.
   */
  workflowStates?: LinearWebhookWorkflowStates
}

export class LinearWebhookReceiver implements WebhookReceiver<ParsedWebhookEvent> {
  private readonly secret: string
  private readonly workflowStates?: LinearWebhookWorkflowStates

  constructor(config: LinearWebhookReceiverConfig) {
    if (!config.secret) {
      throw new Error(
        "LinearWebhookReceiver: secret is required.\n" +
          "  Fix: pass config.linearWebhookSecret when constructing the adapter.\n" +
          "  Source: ~/.config/agent-valley/settings.yaml `linear.webhookSecret`.",
      )
    }
    this.secret = config.secret
    this.workflowStates = config.workflowStates
  }

  verifySignature(payload: string, signature: string): Promise<boolean> {
    return verifyWebhookSignature(payload, signature, this.secret)
  }

  parseEvent(payload: string): ParsedWebhookEvent | null {
    const linearEvent = parseWebhookEvent(payload)
    if (!linearEvent) return null
    return this.toDomainEvent(linearEvent)
  }

  private toDomainEvent(event: LinearParsedWebhookEvent): ParsedWebhookEvent | null {
    // Relation events map onto the domain relation_changed kind.
    if (event.kind === "relation") {
      const relation = normalizeRelation(event.relationType)
      if (!relation) return null
      return {
        kind: "issue.relation_changed",
        issueId: event.issueId,
        relation,
        relatedIssueId: event.relatedIssueId,
        added: event.action === "create",
      }
    }

    // Issue removal webhook.
    if (event.action === "remove") {
      return { kind: "issue.deleted", issueId: event.issueId }
    }

    // Issue update / create. Need state translation.
    const to = this.mapStateId(event.stateId)
    const from = this.mapStateId(event.prevStateId)

    // Legacy Linear webhook semantics: Symphony routes on the *current*
    // logical state, not on a strict "from != to" delta. A webhook that
    // reports `state=todo` should still admit the issue even when the
    // prior state is the same (Linear emits these on creation and on
    // non-state edits that happen to include a state id). We therefore
    // emit `issue.transitioned` any time the adapter can resolve `to`
    // to a logical state — `from === to` is legal.
    if (to) {
      return {
        kind: "issue.transitioned",
        issueId: event.issueId,
        from,
        to,
        issue: event.issue,
      }
    }

    // Fallback: state id did not map (e.g. Backlog, Canceled that the
    // config doesn't enumerate). Emit the generic content update so the
    // router can at least observe the event without dispatching.
    return {
      kind: "issue.updated",
      issueId: event.issueId,
      changedFields: [],
      issue: event.issue,
    }
  }

  private mapStateId(stateId: string | null): IssueStateType | null {
    if (!stateId) return null
    const ws = this.workflowStates
    if (!ws) return null
    if (stateId === ws.todo) return "todo"
    if (stateId === ws.inProgress) return "in_progress"
    if (stateId === ws.done) return "done"
    if (stateId === ws.cancelled) return "cancelled"
    return null
  }
}

function normalizeRelation(type: string): "blocked_by" | "blocks" | null {
  const t = type.toLowerCase()
  if (t === "blocked_by" || t === "blocked-by") return "blocked_by"
  if (t === "blocks") return "blocks"
  return null
}
