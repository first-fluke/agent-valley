/**
 * API Route Handler tests — exercise the Next.js route handlers directly.
 * Tests the webhook, health, and status route functions in isolation.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

// ── Mock orchestrator singleton ─────────────────────────────────────

let mockOrchestrator: {
  getStatus: () => Record<string, unknown>
  handleWebhook: (payload: string, signature: string) => Promise<{ status: number; body: string }>
  stop: () => Promise<void>
  on: (event: string, handler: (...args: unknown[]) => void) => void
  off: (event: string, handler: (...args: unknown[]) => void) => void
} | null = null

vi.mock("@/lib/orchestrator-singleton", () => ({
  getOrchestrator: () => mockOrchestrator,
}))

vi.mock("@/lib/env", () => ({
  env: {
    AGENT_TYPE: "claude",
    MAX_PARALLEL: 5,
    SERVER_PORT: 9741,
  },
}))

// ── Import route handlers after mocks ────────────────────────────────

const { GET: healthGET } = await import("@/app/api/health/route")
const { GET: statusGET } = await import("@/app/api/status/route")
const { POST: webhookPOST } = await import("@/app/api/webhook/route")

describe("API Route Handlers", () => {
  beforeEach(() => {
    mockOrchestrator = {
      getStatus: () => ({ running: true, activeCount: 0, isRunning: true, activeAgents: 0 }),
      handleWebhook: async () => ({
        status: 200,
        body: JSON.stringify({ ok: true }),
      }),
      stop: async () => {},
      on: () => {},
      off: () => {},
    }
  })

  afterEach(() => {
    mockOrchestrator = null
  })

  // ── /api/health ──────────────────────────────────────────────────

  test("GET /health returns 200 with status ok when orchestrator is initialized", async () => {
    const res = healthGET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("ok")
    expect(body).toHaveProperty("isRunning")
    expect(body).toHaveProperty("uptime")
  })

  test("GET /health returns 503 when orchestrator not initialized", async () => {
    mockOrchestrator = null
    const res = healthGET()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.status).toBe("degraded")
  })

  // ── /api/status ──────────────────────────────────────────────────

  test("GET /status returns handler result", async () => {
    if (mockOrchestrator) mockOrchestrator.getStatus = () => ({ running: true, activeCount: 5 })
    const res = statusGET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ running: true, activeCount: 5 })
  })

  test("GET /status returns 503 when orchestrator not initialized", async () => {
    mockOrchestrator = null
    const res = statusGET()
    expect(res.status).toBe(503)
  })

  // ── /api/webhook ─────────────────────────────────────────────────

  test("POST /webhook calls handleWebhook", async () => {
    let receivedPayload = ""
    let receivedSignature = ""

    if (!mockOrchestrator) throw new Error("orchestrator not initialized")
    mockOrchestrator.handleWebhook = async (payload, signature) => {
      receivedPayload = payload
      receivedSignature = signature
      return { status: 200, body: JSON.stringify({ accepted: true }) }
    }

    const req = new Request("http://localhost/api/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "linear-signature": "sig123",
      },
      body: '{"type":"Issue","action":"update"}',
    })

    const res = await webhookPOST(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ accepted: true })
    expect(receivedPayload).toBe('{"type":"Issue","action":"update"}')
    expect(receivedSignature).toBe("sig123")
  })

  test("POST /webhook without application/json Content-Type returns 415", async () => {
    const req = new Request("http://localhost/api/webhook", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "hello",
    })

    const res = await webhookPOST(req)
    expect(res.status).toBe(415)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain("application/json")
  })

  test("POST /webhook with too-large body returns 413", async () => {
    const largeBody = `{"x":"${"a".repeat(1_100_000)}"}`
    const req = new Request("http://localhost/api/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: largeBody,
    })

    const res = await webhookPOST(req)
    expect(res.status).toBe(413)
  })

  test("POST /webhook returns 503 when orchestrator not initialized", async () => {
    mockOrchestrator = null

    const req = new Request("http://localhost/api/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "linear-signature": "sig",
      },
      body: '{"type":"Issue"}',
    })

    const res = await webhookPOST(req)
    expect(res.status).toBe(503)
  })
})
