/**
 * Linear webhook client tests — upsertWebhook (create/update/idempotent)
 * and permission error surfacing.
 */
import { describe, expect, test, vi } from "vitest"

interface MockFetchOpts {
  data: unknown
  status?: number
  errors?: Array<{ message: string }>
}

function mockFetchSequence(responses: MockFetchOpts[]): {
  getAllCaptured: () => Array<{ query: string; variables: Record<string, unknown> }>
  restore: () => void
} {
  const original = globalThis.fetch
  const captured: Array<{ query: string; variables: Record<string, unknown> }> = []
  let callIdx = 0

  globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string)
    captured.push({ query: body.query, variables: body.variables })
    const resp = responses[callIdx] ?? responses[responses.length - 1]
    callIdx++
    return new Response(JSON.stringify({ data: resp?.data ?? {}, errors: resp?.errors }), {
      status: resp?.status ?? 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as unknown as typeof fetch

  return {
    getAllCaptured: () => captured,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

describe("upsertWebhook", () => {
  test("creates a webhook when none exists for the team", async () => {
    const { upsertWebhook } = await import("../tracker/linear-webhook-client")
    const { getAllCaptured, restore } = mockFetchSequence([
      // listWebhooks — none found
      { data: { webhooks: { nodes: [] } } },
      // webhookCreate
      {
        data: {
          webhookCreate: {
            success: true,
            webhook: { id: "wh-1", url: "https://tunnel.example/api/webhook", label: "agent-valley", enabled: true },
          },
        },
      },
    ])

    try {
      const result = await upsertWebhook({
        apiKey: "lin_api_test",
        teamId: "team-1",
        url: "https://tunnel.example/api/webhook",
        secret: "s3cr3t",
      })
      expect(result).toEqual({
        id: "wh-1",
        url: "https://tunnel.example/api/webhook",
        label: "agent-valley",
        enabled: true,
      })

      const calls = getAllCaptured()
      expect(calls).toHaveLength(2)
      expect(calls[1]?.variables).toEqual({
        teamId: "team-1",
        url: "https://tunnel.example/api/webhook",
        secret: "s3cr3t",
        label: "agent-valley",
      })
    } finally {
      restore()
    }
  })

  test("updates the existing webhook matched by label instead of creating a duplicate", async () => {
    const { upsertWebhook } = await import("../tracker/linear-webhook-client")
    const { getAllCaptured, restore } = mockFetchSequence([
      // listWebhooks — existing av webhook, stale URL
      {
        data: {
          webhooks: {
            nodes: [
              { id: "wh-1", url: "https://old-tunnel.example/api/webhook", label: "agent-valley", enabled: true },
            ],
          },
        },
      },
      // webhookUpdate
      {
        data: {
          webhookUpdate: {
            success: true,
            webhook: {
              id: "wh-1",
              url: "https://new-tunnel.example/api/webhook",
              label: "agent-valley",
              enabled: true,
            },
          },
        },
      },
    ])

    try {
      const result = await upsertWebhook({
        apiKey: "lin_api_test",
        teamId: "team-1",
        url: "https://new-tunnel.example/api/webhook",
        secret: "s3cr3t",
      })
      expect(result.id).toBe("wh-1")
      expect(result.url).toBe("https://new-tunnel.example/api/webhook")

      const calls = getAllCaptured()
      expect(calls).toHaveLength(2)
      // Only one webhookUpdate call — no webhookCreate call — proves no duplicate.
      expect(calls[1]?.variables).toEqual({
        id: "wh-1",
        url: "https://new-tunnel.example/api/webhook",
        enabled: true,
      })
    } finally {
      restore()
    }
  })

  test("matches an existing webhook by URL when the label is missing (pre-labelling webhooks)", async () => {
    const { upsertWebhook } = await import("../tracker/linear-webhook-client")
    const { getAllCaptured, restore } = mockFetchSequence([
      {
        data: {
          webhooks: {
            nodes: [{ id: "wh-legacy", url: "https://tunnel.example/api/webhook", label: null, enabled: true }],
          },
        },
      },
      {
        data: {
          webhookUpdate: {
            success: true,
            webhook: { id: "wh-legacy", url: "https://tunnel.example/api/webhook", enabled: true },
          },
        },
      },
    ])

    try {
      const result = await upsertWebhook({
        apiKey: "key",
        teamId: "team-1",
        url: "https://tunnel.example/api/webhook",
        secret: "s3cr3t",
      })
      expect(result.id).toBe("wh-legacy")
      expect(getAllCaptured()).toHaveLength(2)
    } finally {
      restore()
    }
  })

  test("surfaces an actionable error when the API key lacks webhook permission (list)", async () => {
    const { upsertWebhook } = await import("../tracker/linear-webhook-client")
    const { restore } = mockFetchSequence([
      { data: null, errors: [{ message: "You do not have permission to manage webhooks" }] },
    ])

    try {
      await expect(
        upsertWebhook({ apiKey: "key", teamId: "team-1", url: "https://tunnel.example/api/webhook", secret: "s" }),
      ).rejects.toThrow(/lacks permission to list webhooks/)
    } finally {
      restore()
    }
  })

  test("surfaces an actionable error when the API key lacks webhook permission (create)", async () => {
    const { upsertWebhook } = await import("../tracker/linear-webhook-client")
    const { restore } = mockFetchSequence([
      { data: { webhooks: { nodes: [] } } },
      { data: null, errors: [{ message: "Forbidden: insufficient scope" }] },
    ])

    try {
      await expect(
        upsertWebhook({ apiKey: "key", teamId: "team-1", url: "https://tunnel.example/api/webhook", secret: "s" }),
      ).rejects.toThrow(/lacks permission to create webhooks/)
    } finally {
      restore()
    }
  })

  test("throws an actionable error when webhookCreate returns success:false", async () => {
    const { upsertWebhook } = await import("../tracker/linear-webhook-client")
    const { restore } = mockFetchSequence([
      { data: { webhooks: { nodes: [] } } },
      { data: { webhookCreate: { success: false } } },
    ])

    try {
      await expect(
        upsertWebhook({ apiKey: "key", teamId: "team-1", url: "https://tunnel.example/api/webhook", secret: "s" }),
      ).rejects.toThrow(/Failed to create Linear webhook/)
    } finally {
      restore()
    }
  })

  test("never includes the secret in the thrown error message", async () => {
    const { upsertWebhook } = await import("../tracker/linear-webhook-client")
    const { restore } = mockFetchSequence([
      { data: { webhooks: { nodes: [] } } },
      { data: { webhookCreate: { success: false } } },
    ])

    try {
      await upsertWebhook({
        apiKey: "key",
        teamId: "team-1",
        url: "https://tunnel.example/api/webhook",
        secret: "top-secret-value",
      })
      throw new Error("expected upsertWebhook to reject")
    } catch (err) {
      expect((err as Error).message).not.toContain("top-secret-value")
    } finally {
      restore()
    }
  })
})
