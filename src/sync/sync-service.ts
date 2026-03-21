/**
 * Sync Service — Maps inbound external events to Linear operations.
 * Application layer. Coordinates between webhook handlers and the tracker client.
 */

import type { Config } from "../config/config"
import type { SyncEvent } from "../domain/models"
import { verifyGitHubSignature, parseGitHubWebhookEvent } from "./github-webhook-handler"
import { addIssueComment, updateIssueState, fetchIssueByIdentifier } from "../tracker/linear-client"
import { logger } from "../observability/logger"

const COMPONENT = "SyncService"

export class SyncService {
  constructor(private config: Config) {}

  async handleGitHubWebhook(
    payload: string,
    signature: string,
    eventType: string,
  ): Promise<{ status: number; body: string }> {
    const webhookSecret = this.config.integrations.github?.webhookSecret
    if (!webhookSecret) {
      return {
        status: 501,
        body: '{"error":"GitHub webhook sync not configured. Set GITHUB_WEBHOOK_SECRET in .env"}',
      }
    }

    // Verify signature
    const valid = await verifyGitHubSignature(payload, signature, webhookSecret)
    if (!valid) {
      logger.warn(COMPONENT, "GitHub webhook signature invalid")
      return { status: 403, body: '{"error":"Invalid signature"}' }
    }

    // Parse event
    const event = parseGitHubWebhookEvent(payload, eventType)
    if (!event) {
      return { status: 200, body: '{"ok":true,"skipped":"unsupported event"}' }
    }

    if (!event.issueIdentifier) {
      logger.debug(COMPONENT, "No issue identifier found in branch name", {
        kind: event.kind,
        url: event.externalUrl,
      })
      return { status: 200, body: '{"ok":true,"skipped":"no issue identifier in branch"}' }
    }

    // Process the sync event
    await this.processSyncEvent(event)

    return { status: 200, body: '{"ok":true}' }
  }

  private async processSyncEvent(event: SyncEvent): Promise<void> {
    if (!event.issueIdentifier) return

    // Look up the Linear issue by identifier
    let issue
    try {
      issue = await fetchIssueByIdentifier(
        this.config.linearApiKey,
        this.config.linearTeamUuid,
        event.issueIdentifier,
      )
    } catch (err) {
      logger.error(COMPONENT, "Failed to look up Linear issue for sync", {
        issueIdentifier: event.issueIdentifier,
        error: String(err),
      })
      return
    }

    if (!issue) {
      logger.warn(COMPONENT, "No matching Linear issue found for sync event", {
        issueIdentifier: event.issueIdentifier,
        kind: event.kind,
      })
      return
    }

    try {
      switch (event.kind) {
        case "pr_merged":
          await this.handlePrMerged(issue.id, event)
          break
        case "pr_opened":
          await this.handlePrOpened(issue.id, event)
          break
        case "pr_closed":
          await this.handlePrClosed(issue.id, event)
          break
        case "check_suite_completed":
          await this.handleCheckSuiteFailed(issue.id, event)
          break
      }
    } catch (err) {
      logger.error(COMPONENT, "Failed to process sync event", {
        issueIdentifier: event.issueIdentifier,
        kind: event.kind,
        error: String(err),
      })
    }
  }

  private async handlePrMerged(issueId: string, event: SyncEvent): Promise<void> {
    const body = `PR #${event.prNumber} merged: [${event.prTitle}](${event.externalUrl})`
    await addIssueComment(this.config.linearApiKey, issueId, body)

    await updateIssueState(
      this.config.linearApiKey,
      issueId,
      this.config.workflowStates.done,
    )

    logger.info(COMPONENT, "Synced PR merge to Linear Done", {
      issueIdentifier: event.issueIdentifier,
      prNumber: event.prNumber,
    })
  }

  private async handlePrOpened(issueId: string, event: SyncEvent): Promise<void> {
    const body = `PR #${event.prNumber} opened: [${event.prTitle}](${event.externalUrl})`
    await addIssueComment(this.config.linearApiKey, issueId, body)

    logger.info(COMPONENT, "Synced PR opened to Linear comment", {
      issueIdentifier: event.issueIdentifier,
      prNumber: event.prNumber,
    })
  }

  private async handlePrClosed(issueId: string, event: SyncEvent): Promise<void> {
    const body = `PR #${event.prNumber} closed without merge: [${event.prTitle}](${event.externalUrl})`
    await addIssueComment(this.config.linearApiKey, issueId, body)

    logger.info(COMPONENT, "Synced PR closed to Linear comment", {
      issueIdentifier: event.issueIdentifier,
      prNumber: event.prNumber,
    })
  }

  private async handleCheckSuiteFailed(issueId: string, event: SyncEvent): Promise<void> {
    const body = `CI checks failed${event.prNumber ? ` on PR #${event.prNumber}` : ""}\n\n${event.detail ?? ""}`
    await addIssueComment(this.config.linearApiKey, issueId, body)

    logger.info(COMPONENT, "Synced check suite failure to Linear comment", {
      issueIdentifier: event.issueIdentifier,
    })
  }
}
