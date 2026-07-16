/**
 * /api/webhook/github route tests — verifies the route reads the
 * `X-GitHub-Delivery` header and threads it through to
 * `orchestrator.handleWebhook` as the third argument, so
 * `GithubWebhookReceiver.parseEvent` can dedup on the stable delivery id
 * instead of falling back to a body hash.
 *
 * Delivery-id dedup semantics themselves (duplicate rejected, distinct
 * ids/bodies accepted) are covered at the receiver level in
 * `packages/core/src/tracker/adapters/github-webhook-receiver.replay.test.ts`.
 * This suite only proves the HTTP boundary passthrough.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

interface MockOrchestrator {
  handleWebhook: ReturnType<typeof vi.fn>
}

let mockOrchestrator: MockOrchestrator | null = null

vi.mock("@/lib/orchestrator-singleton", () => ({
  getOrchestrator: () => mockOrchestrator,
}))

const { POST: githubWebhookPOST } = await import("@/app/api/webhook/github/route")

function githubRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/webhook/github", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

describe("POST /api/webhook/github", () => {
  beforeEach(() => {
    mockOrchestrator = {
      handleWebhook: vi.fn(async () => ({ status: 200, body: '{"ok":true}' })),
    }
  })

  afterEach(() => {
    mockOrchestrator = null
  })

  test("reads X-GitHub-Delivery and passes it through as the third handleWebhook argument", async () => {
    const res = await githubWebhookPOST(
      githubRequest(
        { action: "opened", issue: { number: 1 } },
        { "x-hub-signature-256": "sha256=abc", "x-github-delivery": "11ee1234-abcd-4321-9999-0123456789ab" },
      ),
    )

    expect(res.status).toBe(200)
    expect(mockOrchestrator?.handleWebhook).toHaveBeenCalledTimes(1)
    const [, , deliveryId] = mockOrchestrator?.handleWebhook.mock.calls[0] ?? []
    expect(deliveryId).toBe("11ee1234-abcd-4321-9999-0123456789ab")
  })

  test("passes undefined deliveryId when X-GitHub-Delivery is missing (body-hash fallback preserved)", async () => {
    await githubWebhookPOST(githubRequest({ action: "opened", issue: { number: 1 } }, { "x-hub-signature-256": "sha256=abc" }))

    expect(mockOrchestrator?.handleWebhook).toHaveBeenCalledTimes(1)
    const [, , deliveryId] = mockOrchestrator?.handleWebhook.mock.calls[0] ?? []
    expect(deliveryId).toBeUndefined()
  })

  test("passes the raw payload and signature through unchanged alongside deliveryId", async () => {
    await githubWebhookPOST(
      githubRequest(
        { action: "opened", issue: { number: 42 } },
        { "x-hub-signature-256": "sha256=deadbeef", "x-github-delivery": "delivery-xyz" },
      ),
    )

    const [payload, signature, deliveryId] = mockOrchestrator?.handleWebhook.mock.calls[0] ?? []
    expect(JSON.parse(payload as string)).toEqual({ action: "opened", issue: { number: 42 } })
    expect(signature).toBe("sha256=deadbeef")
    expect(deliveryId).toBe("delivery-xyz")
  })

  test("returns 503 without calling handleWebhook when orchestrator is not initialized", async () => {
    mockOrchestrator = null
    const res = await githubWebhookPOST(githubRequest({ zen: "ping" }, { "x-github-delivery": "delivery-1" }))
    expect(res.status).toBe(503)
  })

  test("rejects non-JSON content type with 415 before touching the orchestrator", async () => {
    const req = new Request("http://localhost/api/webhook/github", {
      method: "POST",
      headers: { "content-type": "text/plain", "x-github-delivery": "delivery-1" },
      body: "not json",
    })
    const res = await githubWebhookPOST(req)
    expect(res.status).toBe(415)
    expect(mockOrchestrator?.handleWebhook).not.toHaveBeenCalled()
  })
})
