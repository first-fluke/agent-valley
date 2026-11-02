/**
 * GithubReviewWebhookReceiver — receives GitHub `pull_request_review`
 * deliveries when another service (Linear) tracks the issues, so reviews
 * of Agent Valley pull requests can still become follow-up work.
 *
 * Every other GitHub event is ignored; with the GitHub tracker,
 * `GithubWebhookReceiver` already handles reviews on the same endpoint.
 * Signing and replay protection match `GithubWebhookReceiver`.
 */

import type { ParsedWebhookEvent } from "../../domain/parsed-webhook-event"
import type { WebhookReceiver } from "../../domain/ports/tracker"
import { logger } from "../../observability/logger"
import { hashPayloadSha256Hex, WebhookDedupCache } from "../dedup-cache"
import { verifyHmacSha256Hex } from "../hmac-verify"
import { type GithubReviewDeliveryPayload, isReviewDelivery, toReviewEvent } from "./github-payload"

export interface GithubReviewWebhookReceiverConfig {
  /** Signing secret of the GitHub webhook that sends "Pull request reviews". */
  secret: string
  /** Optional injectable replay-protection cache — primarily for tests. */
  dedupCache?: WebhookDedupCache
}

export class GithubReviewWebhookReceiver implements WebhookReceiver<ParsedWebhookEvent> {
  private readonly secret: string
  private readonly dedupCache: WebhookDedupCache

  constructor(config: GithubReviewWebhookReceiverConfig) {
    if (!config.secret) {
      throw new Error(
        "GithubReviewWebhookReceiver: secret is required.\n" +
          "  Fix: set delivery.pull_request_reviews.webhook_secret in av.yaml.",
      )
    }
    this.secret = config.secret
    this.dedupCache = config.dedupCache ?? new WebhookDedupCache()
  }

  async verifySignature(payload: string, signature: string): Promise<boolean> {
    const provided = signature.startsWith("sha256=") ? signature.slice("sha256=".length) : signature
    return verifyHmacSha256Hex(payload, provided, this.secret)
  }

  parseEvent(payload: string, deliveryId?: string): ParsedWebhookEvent | null {
    let raw: GithubReviewDeliveryPayload
    try {
      raw = JSON.parse(payload) as GithubReviewDeliveryPayload
    } catch {
      return null
    }
    if (!isReviewDelivery(raw)) return null
    const event = toReviewEvent(raw)
    if (!event) return null

    const dedupKey = deliveryId ? `delivery:${deliveryId}` : `body:${hashPayloadSha256Hex(payload)}`
    if (!this.dedupCache.checkAndRecord(dedupKey)) {
      logger.warn("tracker-github", "Review webhook rejected: duplicate delivery", {
        dedupKey: deliveryId ?? "body-hash",
      })
      return null
    }
    return event
  }
}
