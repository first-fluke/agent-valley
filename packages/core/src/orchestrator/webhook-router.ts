/**
 * WebhookRouter — Verifies webhook signatures and dispatches parsed
 * events to the IssueLifecycle. Does not own runtime state; it accesses
 * OrchestratorCore only to record lastEventAt and to route retry
 * processing after each event.
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 3.1 / § 5.3 (PR3).
 */

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

    // Parse event
    const event = core.webhook.parseEvent(payload)
    if (!event) {
      return { status: 200, body: '{"ok":true,"skipped":"not an issue event"}' }
    }

    core.touchLastEvent()

    // Route relation events (DAG updates)
    if ("kind" in event && event.kind === "relation") {
      logger.debug("orchestrator", `Relation webhook: ${event.action} ${event.relationType}`, {
        issueId: event.issueId,
        relatedIssueId: event.relatedIssueId,
      })
      if (event.action === "create") {
        core.dagScheduler.addRelation(event.issueId, event.relatedIssueId, event.relationType)
      } else if (event.action === "remove") {
        core.dagScheduler.removeRelation(event.issueId, event.relatedIssueId)
        await this.lifecycle.reevaluateWaitingIssues()
      }
      return { status: 200, body: '{"ok":true}' }
    }

    logger.debug("orchestrator", `Webhook received: ${event.action} for ${event.issue.identifier}`, {
      issueId: event.issueId,
    })

    // Route issue events
    if (event.stateId === core.config.workflowStates.todo) {
      // Instant acknowledgment for webhook-triggered-only (not startup/retry).
      if (!core.processingIssues.has(event.issueId) && !core.state.activeWorkspaces.has(event.issueId)) {
        core.tracker
          .addIssueComment(event.issueId, `Symphony: Received — starting agent for ${event.issue.identifier}`)
          .catch((err) => {
            logger.debug("orchestrator", "Failed to post webhook ack comment", { error: String(err) })
          })
      }
      await this.lifecycle.handleIssueTodo(event.issue)
    } else if (event.stateId === core.config.workflowStates.inProgress) {
      await this.lifecycle.handleIssueInProgress(event.issue)
    } else if (event.prevStateId === core.config.workflowStates.inProgress) {
      await this.lifecycle.handleIssueLeftInProgress(event.issueId)
    }

    // Process retry queue after each event
    await core.processRetryQueue()

    return { status: 200, body: '{"ok":true}' }
  }
}
