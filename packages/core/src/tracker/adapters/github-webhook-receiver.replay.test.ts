/**
 * GithubWebhookReceiver replay/dedup tests — complements
 * `__tests__/github-webhook-receiver.test.ts` (owned by another agent's
 * test directory boundary; this suite is colocated under `tracker/` per
 * this workstream's file-ownership scope).
 */
import { describe, expect, test } from "vitest"
import { WebhookDedupCache } from "../dedup-cache"
import type { GithubStateLabels } from "./github-adapter"
import { GithubWebhookReceiver } from "./github-webhook-receiver"

const LABELS: GithubStateLabels = {
  todo: "valley:todo",
  inProgress: "valley:wip",
  done: "valley:done",
  cancelled: "valley:cancelled",
}

function issuePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "opened",
    issue: {
      number: 42,
      title: "Test issue",
      body: "hello",
      state: "open",
      labels: [],
      html_url: "https://github.com/first-fluke/agent-valley/issues/42",
    },
    repository: { owner: { login: "first-fluke" }, name: "agent-valley" },
    ...overrides,
  })
}

describe("GithubWebhookReceiver — replay protection", () => {
  test("an identical body parsed twice is rejected the second time", () => {
    const receiver = new GithubWebhookReceiver({ secret: "whsec_test", labels: LABELS })
    const payload = issuePayload()

    const first = receiver.parseEvent(payload)
    expect(first).not.toBeNull()

    const second = receiver.parseEvent(payload)
    expect(second).toBeNull()
  })

  test("distinct bodies are never treated as duplicates of each other", () => {
    const receiver = new GithubWebhookReceiver({ secret: "whsec_test", labels: LABELS })
    const a = receiver.parseEvent(issuePayload({ issue: { number: 1, title: "a", body: "", state: "open" } }))
    const b = receiver.parseEvent(issuePayload({ issue: { number: 2, title: "b", body: "", state: "open" } }))
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
  })

  test("an explicit deliveryId dedups independently of body content", () => {
    const receiver = new GithubWebhookReceiver({ secret: "whsec_test", labels: LABELS })
    const payloadA = issuePayload({ issue: { number: 1, title: "a", body: "", state: "open" } })
    const payloadB = issuePayload({ issue: { number: 2, title: "b", body: "", state: "open" } })

    expect(receiver.parseEvent(payloadA, "delivery-1")).not.toBeNull()
    // Same delivery id, different body -> still rejected as a duplicate
    // delivery (this is the GitHub redelivery / capture-replay scenario).
    expect(receiver.parseEvent(payloadB, "delivery-1")).toBeNull()
  })

  test("a different deliveryId is not treated as a duplicate", () => {
    const receiver = new GithubWebhookReceiver({ secret: "whsec_test", labels: LABELS })
    const payload = issuePayload()
    expect(receiver.parseEvent(payload, "delivery-1")).not.toBeNull()
    expect(receiver.parseEvent(payload, "delivery-2")).not.toBeNull()
  })

  test("ping / non-domain payloads never consume a dedup slot", () => {
    const cache = new WebhookDedupCache()
    const receiver = new GithubWebhookReceiver({ secret: "whsec_test", labels: LABELS, dedupCache: cache })
    receiver.parseEvent(JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 }))
    receiver.parseEvent("not-json")
    expect(cache.size).toBe(0)
  })

  test("two independent receiver instances do not share dedup state", () => {
    const payload = issuePayload()
    const receiverA = new GithubWebhookReceiver({ secret: "whsec_test", labels: LABELS })
    const receiverB = new GithubWebhookReceiver({ secret: "whsec_test", labels: LABELS })

    expect(receiverA.parseEvent(payload)).not.toBeNull()
    expect(receiverB.parseEvent(payload)).not.toBeNull()
  })
})
