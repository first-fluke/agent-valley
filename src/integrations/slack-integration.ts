/**
 * Slack Integration — Sends Incoming Webhook notifications for agent lifecycle events.
 * Infrastructure layer adapter. No business logic.
 */

import type { IntegrationEvent, IntegrationStatus } from "../domain/models"
import type { Integration } from "./types"
import { logger } from "../observability/logger"

const COMPONENT = "SlackIntegration"

// ── Block Kit helpers ────────────────────────────────────────────────

interface SlackTextObject {
  type: "plain_text" | "mrkdwn"
  text: string
}

interface SlackHeaderBlock {
  type: "header"
  text: SlackTextObject
}

interface SlackSectionBlock {
  type: "section"
  fields?: SlackTextObject[]
  text?: SlackTextObject
}

type SlackBlock = SlackHeaderBlock | SlackSectionBlock

interface SlackAttachment {
  color: string
  fallback: string
  blocks: SlackBlock[]
}

interface SlackWebhookPayload {
  attachments: SlackAttachment[]
}

// ── Event formatting ─────────────────────────────────────────────────

interface EventFormat {
  header: string
  color: string
}

const EVENT_FORMATS: Record<string, EventFormat> = {
  agent_started:   { header: "Agent Started",    color: "#36a64f" },
  agent_completed: { header: "Agent Completed",  color: "#36a64f" },
  agent_failed:    { header: "Agent Failed",     color: "#dc3545" },
  agent_timeout:   { header: "Agent Timed Out",  color: "#ffc107" },
}

function buildPayload(event: IntegrationEvent): SlackWebhookPayload {
  const fmt = EVENT_FORMATS[event.kind] ?? { header: event.kind, color: "#6c757d" }

  const issueLink = `<${event.issueUrl}|${event.issueIdentifier}: ${event.issueTitle}>`

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: fmt.header },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Issue*\n${issueLink}` },
        { type: "mrkdwn", text: `*Status*\n${event.kind}` },
        { type: "mrkdwn", text: `*Timestamp*\n${event.timestamp}` },
      ],
    },
  ]

  if (event.detail) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: event.detail },
    })
  }

  return {
    attachments: [
      {
        color: fmt.color,
        fallback: `${fmt.header}: ${event.issueIdentifier} — ${event.issueTitle}`,
        blocks,
      },
    ],
  }
}

// ── SlackIntegration ─────────────────────────────────────────────────

export class SlackIntegration implements Integration {
  readonly type = "slack"

  private readonly webhookUrl: string
  private lastEventAt: string | null = null
  private lastError: string | null = null

  constructor(config: { webhookUrl: string }) {
    this.webhookUrl = config.webhookUrl
  }

  status(): IntegrationStatus {
    return {
      type: "slack",
      configured: true,
      lastEventAt: this.lastEventAt,
      error: this.lastError,
    }
  }

  async notify(event: IntegrationEvent): Promise<void> {
    const payload = buildPayload(event)

    try {
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const body = await response.text()
        const msg = `Slack webhook returned ${response.status} ${response.statusText}: ${body}`
        this.lastError = msg
        logger.error(COMPONENT, "Slack notification failed", {
          issueId: event.issueId,
          error: msg,
        })
        return
      }

      this.lastEventAt = event.timestamp
      this.lastError = null

      logger.info(COMPONENT, "Slack notification sent", {
        issueId: event.issueId,
        kind: event.kind,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.lastError = msg
      logger.error(COMPONENT, "Slack notification threw an error", {
        issueId: event.issueId,
        error: msg,
      })
    }
  }
}
