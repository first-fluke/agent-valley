/**
 * E2E Test — Verify Symphony orchestrator receives Linear webhooks.
 *
 * Starts a real HTTP server, sends webhook requests, and asserts responses.
 * No mocks for the HTTP layer — this is a true end-to-end webhook receipt test.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { startHttpServer } from "../server/http-server"
import { verifyWebhookSignature, parseWebhookEvent } from "../tracker/webhook-handler"

const WEBHOOK_SECRET = "test-secret-for-e2e"

// ── Helpers ──────────────────────────────────────────────────────────

async function computeSignature(payload: string, secret: string): Promise<string> {
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

function buildIssuePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "update",
    type: "Issue",
    data: {
      id: "issue-uuid-1",
      identifier: "ACR-5",
      title: "E2E webhook test issue",
      description: "Test description",
      url: "https://linear.app/acr/issue/ACR-5",
      state: { id: "state-in-progress", name: "In Progress", type: "started" },
      team: { id: "team-uuid", key: "ACR" },
    },
    updatedFrom: { stateId: "state-todo" },
    ...overrides,
  })
}

// ── Test Suite ────────────────────────────────────────────────────────

describe("Webhook E2E — server receives and processes Linear webhooks", () => {
  let server: { stop: () => void; port: number }
  let baseUrl: string
  const receivedWebhooks: Array<{ payload: string; signature: string }> = []

  beforeAll(() => {
    server = startHttpServer(0, {
      onWebhook: async (payload, signature) => {
        // Verify signature using the real verifyWebhookSignature
        const valid = await verifyWebhookSignature(payload, signature, WEBHOOK_SECRET)
        if (!valid) {
          return { status: 403, body: '{"error":"Invalid signature"}' }
        }

        const event = parseWebhookEvent(payload)
        receivedWebhooks.push({ payload, signature })

        if (!event) {
          return { status: 200, body: '{"ok":true,"skipped":"not an issue event"}' }
        }

        return { status: 200, body: '{"ok":true}' }
      },
      getStatus: () => ({
        isRunning: true,
        webhooksReceived: receivedWebhooks.length,
      }),
    })
    baseUrl = `http://127.0.0.1:${server.port}`
  })

  afterAll(() => {
    server.stop()
  })

  // ── Happy path: valid webhook ──────────────────────────────────────

  test("POST /webhook with valid signature returns 200", async () => {
    const payload = buildIssuePayload()
    const signature = await computeSignature(payload, WEBHOOK_SECRET)

    const res = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "linear-signature": signature,
      },
      body: payload,
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  test("webhook payload is received by handler", () => {
    expect(receivedWebhooks.length).toBeGreaterThanOrEqual(1)
    const last = receivedWebhooks[receivedWebhooks.length - 1]!
    const parsed = JSON.parse(last.payload)
    expect(parsed.data.identifier).toBe("ACR-5")
  })

  // ── Invalid signature ──────────────────────────────────────────────

  test("POST /webhook with invalid signature returns 403", async () => {
    const payload = buildIssuePayload()
    const badSignature = "0000000000000000000000000000000000000000000000000000000000000000"

    const res = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "linear-signature": badSignature,
      },
      body: payload,
    })

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe("Invalid signature")
  })

  test("POST /webhook with empty signature returns 403", async () => {
    const payload = buildIssuePayload()

    const res = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: payload,
    })

    expect(res.status).toBe(403)
  })

  // ── Non-issue event (skipped) ──────────────────────────────────────

  test("POST /webhook with non-Issue type returns 200 with skipped", async () => {
    const payload = JSON.stringify({ action: "update", type: "Comment", data: {} })
    const signature = await computeSignature(payload, WEBHOOK_SECRET)

    const res = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "linear-signature": signature,
      },
      body: payload,
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.skipped).toBe("not an issue event")
  })

  // ── Health endpoint ────────────────────────────────────────────────

  test("GET /health returns 200 with status ok", async () => {
    const res = await fetch(`${baseUrl}/health`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("ok")
  })

  // ── Status endpoint ────────────────────────────────────────────────

  test("GET /status returns orchestrator state", async () => {
    const res = await fetch(`${baseUrl}/status`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.isRunning).toBe(true)
    expect(body.webhooksReceived).toBeGreaterThanOrEqual(1)
  })

  // ── 404 for unknown routes ─────────────────────────────────────────

  test("GET /unknown returns 404", async () => {
    const res = await fetch(`${baseUrl}/unknown`)
    expect(res.status).toBe(404)
  })
})
