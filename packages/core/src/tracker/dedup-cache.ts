/**
 * WebhookDedupCache — bounded, TTL-evicting in-memory cache used to reject
 * replayed webhook deliveries (a captured-and-resent valid-signature body,
 * or an at-least-once redelivery from the tracker platform).
 *
 * Limitation: this cache is process-local and in-memory by design. It does
 * NOT survive process restarts and is NOT shared across horizontally
 * scaled instances — a replay sent to a different process/instance within
 * the TTL window would not be caught. A durable (Redis / DB-backed) store
 * is a separate workstream; this cache closes the single-process replay
 * window, which is the immediate verified gap.
 */

import { createHash } from "node:crypto"

/** Max number of dedup keys retained before oldest entries are evicted. */
export const DEFAULT_DEDUP_CACHE_MAX_SIZE = 10_000

/** How long a dedup key is remembered before it is eligible for eviction. */
export const DEFAULT_DEDUP_TTL_MS = 10 * 60 * 1000 // 10 minutes

/** Default freshness window for timestamp-based replay protection (Linear). */
export const WEBHOOK_REPLAY_FRESHNESS_WINDOW_MS = 60_000 // 60 seconds

export interface WebhookDedupCacheOptions {
  maxSize?: number
  ttlMs?: number
}

/**
 * Returns the lowercase hex SHA-256 digest of `payload`. Used to build
 * dedup keys from the raw webhook body when no platform-provided delivery
 * id is available.
 */
export function hashPayloadSha256Hex(payload: string): string {
  return createHash("sha256").update(payload).digest("hex")
}

/**
 * Bounded, TTL-evicting "seen key" set.
 *
 * Eviction is insertion-order (not access-order) once `maxSize` is
 * reached — sufficient for a replay-rejection cache where the goal is
 * "don't grow unbounded", not perfect LRU recency.
 */
export class WebhookDedupCache {
  private readonly maxSize: number
  private readonly ttlMs: number
  private readonly seen = new Map<string, number>() // key -> expiresAt (ms epoch)

  constructor(options: WebhookDedupCacheOptions = {}) {
    this.maxSize = options.maxSize ?? DEFAULT_DEDUP_CACHE_MAX_SIZE
    this.ttlMs = options.ttlMs ?? DEFAULT_DEDUP_TTL_MS
  }

  /**
   * Record `key` as seen and report whether it was new.
   *
   * Returns `true` when `key` has not been recorded before (or its prior
   * record has expired) — the caller should proceed. Returns `false` when
   * `key` is a live duplicate — the caller should reject the event.
   */
  checkAndRecord(key: string, now: number = Date.now()): boolean {
    this.evictExpired(now)

    const expiresAt = this.seen.get(key)
    if (expiresAt !== undefined && expiresAt > now) {
      return false
    }

    if (this.seen.size >= this.maxSize && !this.seen.has(key)) {
      const oldestKey = this.seen.keys().next().value
      if (oldestKey !== undefined) this.seen.delete(oldestKey)
    }

    this.seen.set(key, now + this.ttlMs)
    return true
  }

  get size(): number {
    return this.seen.size
  }

  private evictExpired(now: number): void {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(key)
      else break // Map iterates insertion order; expiresAt is monotonic with insertion.
    }
  }
}

export type ReplayCheckResult = { ok: true } | { ok: false; reason: "stale" | "duplicate" }

/**
 * Linear-specific replay guard: reject webhooks whose `webhookTimestamp`
 * falls outside the freshness window, then dedup on
 * `webhookTimestamp + hash(body)`.
 *
 * Deliberately keyed off the signed body content (not just the timestamp)
 * so two distinct events that happen to share a millisecond timestamp are
 * not falsely treated as duplicates.
 */
export function checkWebhookFreshnessAndDedup(
  payload: string,
  webhookTimestampMs: number,
  cache: WebhookDedupCache,
  options: { freshnessWindowMs?: number; now?: number } = {},
): ReplayCheckResult {
  const now = options.now ?? Date.now()
  const windowMs = options.freshnessWindowMs ?? WEBHOOK_REPLAY_FRESHNESS_WINDOW_MS

  if (Math.abs(now - webhookTimestampMs) > windowMs) {
    return { ok: false, reason: "stale" }
  }

  const key = `${webhookTimestampMs}:${hashPayloadSha256Hex(payload)}`
  if (!cache.checkAndRecord(key, now)) {
    return { ok: false, reason: "duplicate" }
  }

  return { ok: true }
}
