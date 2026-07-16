/**
 * dedup-cache tests — bounded TTL dedup set + Linear freshness/dedup guard.
 */
import { describe, expect, test } from "vitest"
import {
  checkWebhookFreshnessAndDedup,
  hashPayloadSha256Hex,
  WEBHOOK_REPLAY_FRESHNESS_WINDOW_MS,
  WebhookDedupCache,
} from "./dedup-cache"

describe("WebhookDedupCache", () => {
  test("first sighting of a key returns true (not a duplicate)", () => {
    const cache = new WebhookDedupCache()
    expect(cache.checkAndRecord("k1")).toBe(true)
  })

  test("second sighting of the same key within TTL returns false (duplicate)", () => {
    const cache = new WebhookDedupCache()
    expect(cache.checkAndRecord("k1")).toBe(true)
    expect(cache.checkAndRecord("k1")).toBe(false)
  })

  test("distinct keys never collide", () => {
    const cache = new WebhookDedupCache()
    expect(cache.checkAndRecord("k1")).toBe(true)
    expect(cache.checkAndRecord("k2")).toBe(true)
  })

  test("a key becomes re-usable again after its TTL expires", () => {
    const cache = new WebhookDedupCache({ ttlMs: 1_000 })
    const t0 = 1_000_000
    expect(cache.checkAndRecord("k1", t0)).toBe(true)
    expect(cache.checkAndRecord("k1", t0 + 500)).toBe(false) // still live
    expect(cache.checkAndRecord("k1", t0 + 1_001)).toBe(true) // expired -> new
  })

  test("bounded size evicts the oldest entry once maxSize is reached", () => {
    const cache = new WebhookDedupCache({ maxSize: 2, ttlMs: 60_000 })
    const now = 1_000_000
    expect(cache.checkAndRecord("k1", now)).toBe(true)
    expect(cache.checkAndRecord("k2", now)).toBe(true)
    expect(cache.size).toBe(2)
    // Inserting a 3rd distinct key evicts k1 (oldest).
    expect(cache.checkAndRecord("k3", now)).toBe(true)
    expect(cache.size).toBe(2)
    // k1 was evicted, so it is treated as new again.
    expect(cache.checkAndRecord("k1", now)).toBe(true)
  })
})

describe("hashPayloadSha256Hex", () => {
  test("is deterministic for identical input", () => {
    expect(hashPayloadSha256Hex("abc")).toBe(hashPayloadSha256Hex("abc"))
  })

  test("differs for different input", () => {
    expect(hashPayloadSha256Hex("abc")).not.toBe(hashPayloadSha256Hex("abd"))
  })
})

describe("checkWebhookFreshnessAndDedup", () => {
  test("accepts a fresh, first-seen payload", () => {
    const cache = new WebhookDedupCache()
    const now = 1_700_000_000_000
    const result = checkWebhookFreshnessAndDedup("{}", now, cache, { now })
    expect(result).toEqual({ ok: true })
  })

  test("rejects a payload whose timestamp is older than the freshness window", () => {
    const cache = new WebhookDedupCache()
    const now = 1_700_000_000_000
    const stale = now - WEBHOOK_REPLAY_FRESHNESS_WINDOW_MS - 1
    const result = checkWebhookFreshnessAndDedup("{}", stale, cache, { now })
    expect(result).toEqual({ ok: false, reason: "stale" })
  })

  test("rejects a payload whose timestamp is in the future beyond the freshness window", () => {
    const cache = new WebhookDedupCache()
    const now = 1_700_000_000_000
    const future = now + WEBHOOK_REPLAY_FRESHNESS_WINDOW_MS + 1
    const result = checkWebhookFreshnessAndDedup("{}", future, cache, { now })
    expect(result).toEqual({ ok: false, reason: "stale" })
  })

  test("accepts a timestamp exactly at the freshness window boundary", () => {
    const cache = new WebhookDedupCache()
    const now = 1_700_000_000_000
    const boundary = now - WEBHOOK_REPLAY_FRESHNESS_WINDOW_MS
    const result = checkWebhookFreshnessAndDedup("{}", boundary, cache, { now })
    expect(result).toEqual({ ok: true })
  })

  test("rejects a second identical (timestamp + body) delivery as a duplicate", () => {
    const cache = new WebhookDedupCache()
    const now = 1_700_000_000_000
    const payload = '{"a":1}'
    expect(checkWebhookFreshnessAndDedup(payload, now, cache, { now })).toEqual({ ok: true })
    expect(checkWebhookFreshnessAndDedup(payload, now, cache, { now })).toEqual({ ok: false, reason: "duplicate" })
  })

  test("same timestamp but different body content is not treated as a duplicate", () => {
    const cache = new WebhookDedupCache()
    const now = 1_700_000_000_000
    expect(checkWebhookFreshnessAndDedup('{"a":1}', now, cache, { now })).toEqual({ ok: true })
    expect(checkWebhookFreshnessAndDedup('{"a":2}', now, cache, { now })).toEqual({ ok: true })
  })

  test("custom freshnessWindowMs overrides the default", () => {
    const cache = new WebhookDedupCache()
    const now = 1_700_000_000_000
    const result = checkWebhookFreshnessAndDedup("{}", now - 5_000, cache, { now, freshnessWindowMs: 1_000 })
    expect(result).toEqual({ ok: false, reason: "stale" })
  })
})
