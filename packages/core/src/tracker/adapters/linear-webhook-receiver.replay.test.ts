/**
 * LinearWebhookReceiver replay/freshness tests — exercises the real
 * `webhook-handler.ts::parseWebhookEvent` (no mocking), complementing
 * `__tests__/adapters.test.ts` (owned by another agent's test directory
 * boundary; this suite is colocated under `tracker/` per this
 * workstream's file-ownership scope).
 */
import { describe, expect, test } from "vitest"
import type { ParsedWebhookEvent } from "../../domain/parsed-webhook-event"
import type { WebhookReceiver } from "../../domain/ports/tracker"
import { WEBHOOK_REPLAY_FRESHNESS_WINDOW_MS, WebhookDedupCache } from "../dedup-cache"
import { LinearWebhookReceiver } from "./linear-webhook-receiver"

function makePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "Issue",
    action: "update",
    data: {
      id: "issue-123",
      identifier: "ACR-42",
      title: "Fix the bug",
      description: "Detailed description",
      url: "https://linear.app/acr/issue/ACR-42",
      state: { id: "state-ip", name: "In Progress", type: "started" },
      team: { id: "team-uuid", key: "ACR" },
    },
    updatedFrom: { stateId: "state-todo" },
    ...overrides,
  })
}

describe("LinearWebhookReceiver — replay protection", () => {
  test("a fresh payload with webhookTimestamp is accepted", () => {
    const receiver = new LinearWebhookReceiver({ secret: "whsec" })
    const now = Date.now()
    const ev = receiver.parseEvent(makePayload({ webhookTimestamp: now }))
    expect(ev).not.toBeNull()
  })

  test("a payload without webhookTimestamp is accepted unconditionally (back-compat)", () => {
    const receiver = new LinearWebhookReceiver({ secret: "whsec" })
    const ev = receiver.parseEvent(makePayload())
    expect(ev).not.toBeNull()
  })

  test("a stale payload (older than the freshness window) is rejected", () => {
    const receiver = new LinearWebhookReceiver({ secret: "whsec" })
    const stale = Date.now() - WEBHOOK_REPLAY_FRESHNESS_WINDOW_MS - 5_000
    const ev = receiver.parseEvent(makePayload({ webhookTimestamp: stale }))
    expect(ev).toBeNull()
  })

  test("replaying the exact same payload a second time is rejected as a duplicate", () => {
    const receiver = new LinearWebhookReceiver({ secret: "whsec" })
    const payload = makePayload({ webhookTimestamp: Date.now() })

    const first = receiver.parseEvent(payload)
    expect(first).not.toBeNull()

    const second = receiver.parseEvent(payload)
    expect(second).toBeNull()
  })

  test("two different issues at the same timestamp are both accepted (no false-positive dedup)", () => {
    const receiver = new LinearWebhookReceiver({ secret: "whsec" })
    const ts = Date.now()
    const a = receiver.parseEvent(
      makePayload({
        webhookTimestamp: ts,
        data: { ...JSON.parse(makePayload()).data, id: "issue-1", identifier: "ACR-1" },
      }),
    )
    const b = receiver.parseEvent(
      makePayload({
        webhookTimestamp: ts,
        data: { ...JSON.parse(makePayload()).data, id: "issue-2", identifier: "ACR-2" },
      }),
    )
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
  })

  test("relation events are also replay-protected", () => {
    const receiver = new LinearWebhookReceiver({ secret: "whsec" })
    const payload = JSON.stringify({
      type: "IssueRelation",
      action: "create",
      data: { id: "rel-1", type: "blocks", issueId: "issue-A", relatedIssueId: "issue-B" },
      webhookTimestamp: Date.now(),
    })

    expect(receiver.parseEvent(payload)).not.toBeNull()
    expect(receiver.parseEvent(payload)).toBeNull()
  })

  test("an injected dedupCache is used instead of the receiver's private default", () => {
    const cache = new WebhookDedupCache()
    const receiver = new LinearWebhookReceiver({ secret: "whsec", dedupCache: cache })
    const payload = makePayload({ webhookTimestamp: Date.now() })

    receiver.parseEvent(payload)
    expect(cache.size).toBe(1)
  })

  test("two independent receiver instances do not share dedup state", () => {
    const payload = makePayload({ webhookTimestamp: Date.now() })
    const receiverA = new LinearWebhookReceiver({ secret: "whsec" })
    const receiverB = new LinearWebhookReceiver({ secret: "whsec" })

    expect(receiverA.parseEvent(payload)).not.toBeNull()
    expect(receiverB.parseEvent(payload)).not.toBeNull()
  })

  test("interface-change safety: an extra deliveryId argument (GitHub-only param) is silently ignored", () => {
    // WebhookReceiver.parseEvent gained an optional `deliveryId` second
    // parameter so GithubWebhookReceiver can dedup on X-GitHub-Delivery.
    // LinearWebhookReceiver never declares the parameter, so passing one
    // through the shared call site must be a no-op — dedup still runs on
    // webhookTimestamp + body hash exactly as before. Typed through the
    // `WebhookReceiver` port (not the concrete class) since that's how
    // WebhookRouter actually calls it (`core.webhook.parseEvent(...)`).
    const receiver: WebhookReceiver<ParsedWebhookEvent> = new LinearWebhookReceiver({ secret: "whsec" })
    const payload = makePayload({ webhookTimestamp: Date.now() })

    const first = receiver.parseEvent(payload, "some-delivery-id")
    expect(first).not.toBeNull()

    // Same body, different "deliveryId" -> still dedup'd as a body replay
    // (deliveryId is not part of Linear's dedup key).
    const second = receiver.parseEvent(payload, "a-different-delivery-id")
    expect(second).toBeNull()
  })
})
