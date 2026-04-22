/**
 * LinearWebhookReceiver — Infrastructure adapter implementing the domain
 * `WebhookReceiver` port against Linear's HMAC-SHA256 webhook contract.
 *
 * Composition only: delegates to the existing module functions in
 * `../webhook-handler.ts` so the webhook-handler unit tests continue to
 * exercise the same parse logic unchanged.
 *
 * Design: docs/plans/domain-ports-di-seam-design.md § 3.2
 */

import type { WebhookReceiver } from "../../domain/ports/tracker"
import type { ParsedWebhookEvent } from "../types"
import { parseWebhookEvent, verifyWebhookSignature } from "../webhook-handler"

export interface LinearWebhookReceiverConfig {
  /** Webhook signing secret from Linear (matches Config.linearWebhookSecret). */
  secret: string
}

export class LinearWebhookReceiver implements WebhookReceiver<ParsedWebhookEvent> {
  constructor(private readonly config: LinearWebhookReceiverConfig) {
    if (!config.secret) {
      throw new Error(
        "LinearWebhookReceiver: secret is required.\n" +
          "  Fix: pass config.linearWebhookSecret when constructing the adapter.\n" +
          "  Source: ~/.config/agent-valley/settings.yaml `linear.webhookSecret`.",
      )
    }
  }

  verifySignature(payload: string, signature: string): Promise<boolean> {
    return verifyWebhookSignature(payload, signature, this.config.secret)
  }

  parseEvent(payload: string): ParsedWebhookEvent | null {
    return parseWebhookEvent(payload)
  }
}
