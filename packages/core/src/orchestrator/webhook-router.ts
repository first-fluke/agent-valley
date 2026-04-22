/**
 * WebhookRouter — Verifies webhook signatures and dispatches parsed
 * events to the IssueLifecycle. Does not own runtime state; it accesses
 * OrchestratorCore only to record lastEventAt and to route retry
 * processing after each event.
 *
 * PR4: routes on the tracker-agnostic domain `ParsedWebhookEvent`
 * union (`domain/parsed-webhook-event.ts`). Legacy Linear-shaped event
 * access is gone from the router — translation lives in the
 * `WebhookReceiver` adapter.
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 3.1 / § 5.3 (PR3),
 *         docs/plans/v0-2-bigbang-design.md § 4.2 (PR4).
 */

import type { ParsedWebhookEvent } from "../domain/parsed-webhook-event"
import { logger } from "../observability/logger"
import type { IssueLifecycle } from "./issue-lifecycle"
import type { OrchestratorCore } from "./orchestrator-core"

export interface WebhookResponse {
  status: number
  body: string
}

export class WebhookRouter {
  constructor(
    private readonly core: OrchestratorCore,
    private readonly lifecycle: IssueLifecycle,
  ) {}

  async handleWebhook(payload: string, signature: string): Promise<WebhookResponse> {
    const { core } = this

    // Verify signature
    const valid = await core.webhook.verifySignature(payload, signature)
    if (!valid) {
      logger.warn("orchestrator", "Webhook signature invalid")
      return { status: 403, body: '{"error":"Invalid signature"}' }
    }

    // Parse event into the domain union
    const event = core.webhook.parseEvent(payload) as ParsedWebhookEvent | null
    if (!event) {
      return { status: 200, body: '{"ok":true,"skipped":"not an issue event"}' }
    }

    core.touchLastEvent()

    await this.dispatch(event)

    // Process retry queue after each event
    await core.processRetryQueue()

    return { status: 200, body: '{"ok":true}' }
  }

  private async dispatch(event: ParsedWebhookEvent): Promise<void> {
    const { core, lifecycle } = this

    switch (event.kind) {
      case "issue.relation_changed": {
        logger.debug("orchestrator", `Relation webhook: ${event.added ? "create" : "remove"} ${event.relation}`, {
          issueId: event.issueId,
          relatedIssueId: event.relatedIssueId,
        })
        if (event.added) {
          core.dagScheduler.addRelation(event.issueId, event.relatedIssueId, event.relation)
        } else {
          core.dagScheduler.removeRelation(event.issueId, event.relatedIssueId)
          await lifecycle.reevaluateWaitingIssues()
        }
        return
      }

      case "issue.transitioned": {
        logger.debug("orchestrator", `Webhook transition ${event.from ?? "∅"} -> ${event.to}`, {
          issueId: event.issueId,
          identifier: event.issue.identifier,
        })

        // Left-InProgress: stop the active agent (Done/Cancelled/Todo/…).
        if (event.from === "in_progress" && event.to !== "in_progress") {
          await lifecycle.handleIssueLeftInProgress(event.issueId)
          // Fall-through only for to === "todo"; otherwise return.
          if (event.to !== "todo") return
        }

        if (event.to === "todo") {
          // Instant acknowledgment for webhook-triggered-only (not startup/retry).
          if (!core.processingIssues.has(event.issueId) && !core.state.activeWorkspaces.has(event.issueId)) {
            core.tracker
              .addIssueComment(event.issueId, `Symphony: Received — starting agent for ${event.issue.identifier}`)
              .catch((err) => {
                logger.debug("orchestrator", "Failed to post webhook ack comment", { error: String(err) })
              })
          }
          await lifecycle.handleIssueTodo(event.issue)
          return
        }

        if (event.to === "in_progress") {
          await lifecycle.handleIssueInProgress(event.issue)
          return
        }

        // to = done | cancelled with no prior in_progress — no-op here.
        return
      }

      case "issue.labeled": {
        // Label-based routing is evaluated at dispatch time via
        // `resolveRouteWithScore` — a standalone labeled webhook without
        // a state transition is informational; skip.
        logger.debug("orchestrator", `Webhook labeled: ${event.label}`, { issueId: event.issueId })
        return
      }

      case "issue.updated": {
        // Content-only update (title / description / labels without a
        // tracked state change). Router has nothing to do — downstream
        // re-fetches at dispatch time if needed.
        logger.debug("orchestrator", "Webhook content-only update; skipping", {
          issueId: event.issueId,
          changedFields: event.changedFields.join(",") || "<none>",
        })
        return
      }

      case "issue.deleted": {
        logger.debug("orchestrator", "Webhook issue deleted", { issueId: event.issueId })
        // Treat as left-in-progress: stop the agent if one is active so
        // we don't leak a worktree when the issue is removed upstream.
        await lifecycle.handleIssueLeftInProgress(event.issueId)
        return
      }
    }
  }
}
