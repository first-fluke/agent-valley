/**
 * Webhook Handler tests — signature verification and payload parsing.
 */
import { describe, test, expect } from "bun:test"
import { verifyWebhookSignature, parseWebhookEvent } from "../tracker/webhook-handler.ts"

// ── Helper: compute HMAC-SHA256 hex digest ──────────────────────────

async function computeHmac(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload))
  return Buffer.from(sig).toString("hex")
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
    const event = parseWebhookEvent(makePayload())
    expect(event).not.toBeNull()
    expect(event!.action).toBe("update")
    expect(event!.issueId).toBe("issue-123")
    expect(event!.issue.identifier).toBe("ACR-42")
    expect(event!.issue.title).toBe("Fix the bug")
    expect(event!.stateId).toBe("state-ip")
    expect(event!.prevStateId).toBe("state-todo")
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
    const event = parseWebhookEvent(payload)
    expect(event).not.toBeNull()
    expect(event!.issue.status.id).toBe("")
    expect(event!.issue.status.name).toBe("")
    expect(event!.issue.team.id).toBe("")
    expect(event!.issue.team.key).toBe("")
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
    const event = parseWebhookEvent(payload)
    expect(event).not.toBeNull()
    expect(event!.prevStateId).toBeNull()
  })
})
