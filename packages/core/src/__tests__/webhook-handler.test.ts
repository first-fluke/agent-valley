/**
 * Webhook Handler tests — signature verification and payload parsing.
 */
import { describe, expect, test } from "vitest"
import type { RelationWebhookEvent, WebhookEvent } from "../tracker/types"
import { parseWebhookEvent, verifyWebhookSignature } from "../tracker/webhook-handler.ts"

// ── Helper: compute HMAC-SHA256 hex digest ──────────────────────────

async function computeHmac(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload))
  return Buffer.from(sig).toString("hex")
}

function asIssueEvent(event: unknown): WebhookEvent {
  const e = event as WebhookEvent
  if (e && !("kind" in e && (e as unknown as Record<string, unknown>).kind === "relation")) return e
  throw new Error("Expected WebhookEvent, got RelationWebhookEvent")
}

// ── verifyWebhookSignature ──────────────────────────────────────────

describe("verifyWebhookSignature", () => {
  const secret = "whsec_test_secret_123"

  test("valid signature returns true", async () => {
    const payload = '{"type":"Issue","action":"update"}'
    const sig = await computeHmac(payload, secret)
    expect(await verifyWebhookSignature(payload, sig, secret)).toBe(true)
  })

  test("invalid signature returns false", async () => {
    const payload = '{"type":"Issue","action":"update"}'
    const sig = "0000000000000000000000000000000000000000000000000000000000000000"
    expect(await verifyWebhookSignature(payload, sig, secret)).toBe(false)
  })

  test("empty signature returns false", async () => {
    const payload = '{"type":"Issue","action":"update"}'
    expect(await verifyWebhookSignature(payload, "", secret)).toBe(false)
  })

  test("empty payload with valid signature works", async () => {
    const payload = ""
    const sig = await computeHmac(payload, secret)
    expect(await verifyWebhookSignature(payload, sig, secret)).toBe(true)
  })

  test("tampered payload returns false", async () => {
    const payload = '{"type":"Issue","action":"update"}'
    const sig = await computeHmac(payload, secret)
    const tampered = '{"type":"Issue","action":"remove"}'
    expect(await verifyWebhookSignature(tampered, sig, secret)).toBe(false)
  })
})

// ── parseWebhookEvent ───────────────────────────────────────────────

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

describe("parseWebhookEvent", () => {
  test("valid Issue update event returns WebhookEvent", () => {
    const event = asIssueEvent(parseWebhookEvent(makePayload()))
    expect(event.action).toBe("update")
    expect(event.issueId).toBe("issue-123")
    expect(event.issue.identifier).toBe("ACR-42")
    expect(event.issue.title).toBe("Fix the bug")
    expect(event.stateId).toBe("state-ip")
    expect(event.prevStateId).toBe("state-todo")
  })

  test("non-Issue type returns null", () => {
    const event = parseWebhookEvent(makePayload({ type: "Comment" }))
    expect(event).toBeNull()
  })

  test("missing action returns null", () => {
    const payload = JSON.stringify({ type: "Issue", data: { id: "x" } })
    const event = parseWebhookEvent(payload)
    expect(event).toBeNull()
  })

  test("missing data field returns null", () => {
    const payload = JSON.stringify({ type: "Issue", action: "update" })
    const event = parseWebhookEvent(payload)
    expect(event).toBeNull()
  })

  test("malformed JSON returns null", () => {
    const event = parseWebhookEvent("{not valid json")
    expect(event).toBeNull()
  })

  test("missing nested state/team fields default gracefully", () => {
    const payload = JSON.stringify({
      type: "Issue",
      action: "create",
      data: {
        id: "issue-456",
        identifier: "ACR-99",
        title: "New issue",
        // no state, no team
      },
    })
    const event = asIssueEvent(parseWebhookEvent(payload))
    expect(event.issue.status.id).toBe("")
    expect(event.issue.status.name).toBe("")
    expect(event.issue.team.id).toBe("")
    expect(event.issue.team.key).toBe("")
  })

  test("missing updatedFrom sets prevStateId to null", () => {
    const payload = JSON.stringify({
      type: "Issue",
      action: "create",
      data: {
        id: "issue-789",
        identifier: "ACR-1",
        title: "Fresh",
        state: { id: "s1", name: "Todo", type: "unstarted" },
        team: { id: "t1", key: "ACR" },
      },
    })
    const event = asIssueEvent(parseWebhookEvent(payload))
    expect(event.prevStateId).toBeNull()
  })
})

// ── IssueRelation webhook events ────────────────────────────────────

describe("parseWebhookEvent — IssueRelation", () => {
  test("valid IssueRelation create event", () => {
    const payload = JSON.stringify({
      type: "IssueRelation",
      action: "create",
      data: {
        id: "rel-1",
        type: "blocks",
        issueId: "issue-A",
        relatedIssueId: "issue-B",
      },
    })
    const event = parseWebhookEvent(payload) as RelationWebhookEvent
    expect(event).not.toBeNull()
    expect(event.kind).toBe("relation")
    expect(event.action).toBe("create")
    expect(event.issueId).toBe("issue-A")
    expect(event.relatedIssueId).toBe("issue-B")
    expect(event.relationType).toBe("blocks")
  })

  test("valid IssueRelation remove event", () => {
    const payload = JSON.stringify({
      type: "IssueRelation",
      action: "remove",
      data: {
        id: "rel-2",
        type: "blocked-by",
        issueId: "issue-X",
        relatedIssueId: "issue-Y",
      },
    })
    const event = parseWebhookEvent(payload) as RelationWebhookEvent
    expect(event).not.toBeNull()
    expect(event.kind).toBe("relation")
    expect(event.action).toBe("remove")
  })

  test("IssueRelation with missing fields returns null", () => {
    const payload = JSON.stringify({
      type: "IssueRelation",
      action: "create",
      data: { id: "rel-3" },
    })
    const event = parseWebhookEvent(payload)
    expect(event).toBeNull()
  })
})
