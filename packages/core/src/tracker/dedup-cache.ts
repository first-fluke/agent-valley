/**
 * WebhookDedupCache — bounded, TTL-evicting in-memory cache used to reject
 * replayed webhook deliveries (a captured-and-resent valid-signature body,
 * or an at-least-once redelivery from the tracker platform).
 *
 * The cache answers synchronously from memory. With a `DedupKeyStore`
 * (`state/sqlite-dedup-store.ts`) keys are also written through, and
 * `hydrate()` reloads the live ones at boot, so a replay after a restart
 * is still rejected. It is still not shared across horizontally scaled
 * instances.
 */

import { createHash } from "node:crypto"

/** Max number of dedup keys retained before oldest entries are evicted. */
export const DEFAULT_DEDUP_CACHE_MAX_SIZE = 10_000

/** How long a dedup key is remembered before it is eligible for eviction. */
export const DEFAULT_DEDUP_TTL_MS = 10 * 60 * 1000 // 10 minutes

/** Default freshness window for timestamp-based replay protection (Linear). */
export const WEBHOOK_REPLAY_FRESHNESS_WINDOW_MS = 60_000 // 60 seconds

/** Durable backing for the cache; writes are fire-and-forget. */
export interface DedupKeyStore {
  loadLive(now: number): Promise<Array<{ key: string; expiresAt: number }>>
  record(key: string, expiresAt: number): void
  purgeExpired(now: number): void
}

export interface WebhookDedupCacheOptions {
  maxSize?: number
  ttlMs?: number
  store?: DedupKeyStore
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
  private readonly store: DedupKeyStore | null
  private readonly seen = new Map<string, number>() // key -> expiresAt (ms epoch)

  constructor(options: WebhookDedupCacheOptions = {}) {
    this.maxSize = options.maxSize ?? DEFAULT_DEDUP_CACHE_MAX_SIZE
    this.ttlMs = options.ttlMs ?? DEFAULT_DEDUP_TTL_MS
    this.store = options.store ?? null
  }

  /** Reload the keys still alive in the store. Call once before the first webhook. */
  async hydrate(now: number = Date.now()): Promise<void> {
    if (!this.store) return
    this.store.purgeExpired(now)
    // The store returns keys ordered by expiry, which keeps `seen` in
    // insertion order of expiry as `evictExpired` expects.
    for (const { key, expiresAt } of await this.store.loadLive(now)) {
      if (this.seen.size >= this.maxSize) break
      this.seen.set(key, expiresAt)
    }
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
    this.store?.record(key, now + this.ttlMs)
    return true
  }

  get size(): number {
    return this.seen.size
  }

  private evictExpired(now: number): void {
    let evicted = false
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) {
        this.seen.delete(key)
        evicted = true
      } else break // Map iterates insertion order; expiresAt is monotonic with insertion.
    }
    if (evicted) this.store?.purgeExpired(now)
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
