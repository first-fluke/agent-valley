/**
 * HTTP Server integration tests — start a real server, exercise routes.
 */
import { describe, test, expect, afterEach } from "bun:test"
import { startHttpServer } from "../server/http-server.ts"
import type { WebhookHandlerFn, StatusFn } from "../server/http-server.ts"

// Use a high random port to avoid conflicts
function randomPort(): number {
  return 10_000 + Math.floor(Math.random() * 50_000)
}

describe("HTTP Server", () => {
  let stopServer: (() => void) | null = null

  afterEach(() => {
    if (stopServer) {
      stopServer()
      stopServer = null
    }
  })

  function startTestServer(overrides: {
    onWebhook?: WebhookHandlerFn
    getStatus?: StatusFn
  } = {}) {
    const port = randomPort()
    const onWebhook: WebhookHandlerFn = overrides.onWebhook ?? (async () => ({
      status: 200,
      body: JSON.stringify({ ok: true }),
    }))
    const getStatus: StatusFn = overrides.getStatus ?? (() => ({
      running: true,
      activeCount: 0,
    }))

    const server = startHttpServer(port, { onWebhook, getStatus })
    stopServer = server.stop
    return { port, server }
  }

  test("GET /health returns 200 with status ok", async () => {
    const { port } = startTestServer()
    const res = await fetch(`http://127.0.0.1:${port}/health`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ status: "ok" })
  })

  test("GET /status returns handler result", async () => {
    const { port } = startTestServer({
      getStatus: () => ({ running: true, activeCount: 5 }),
    })
    const res = await fetch(`http://127.0.0.1:${port}/status`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ running: true, activeCount: 5 })
  })

  test("unknown route returns 404 JSON", async () => {
    const { port } = startTestServer()
    const res = await fetch(`http://127.0.0.1:${port}/nonexistent`)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body).toEqual({ error: "Not found" })
  })

  test("POST /webhook calls onWebhook handler", async () => {
    let receivedPayload = ""
    let receivedSignature = ""

    const { port } = startTestServer({
      onWebhook: async (payload, signature) => {
        receivedPayload = payload
        receivedSignature = signature
        return { status: 200, body: JSON.stringify({ accepted: true }) }
      },
    })

    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "linear-signature": "sig123",
      },
      body: '{"type":"Issue","action":"update"}',
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ accepted: true })
    expect(receivedPayload).toBe('{"type":"Issue","action":"update"}')
    expect(receivedSignature).toBe("sig123")
  })

  test("POST /webhook without application/json Content-Type returns 415", async () => {
    const { port } = startTestServer()
    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "hello",
    })
    expect(res.status).toBe(415)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain("application/json")
  })

  test("POST /webhook with too-large body returns 413", async () => {
    const { port } = startTestServer()
    // Bun's fetch overrides Content-Length to match actual body size,
    // so we must send a body that actually exceeds the 1MB limit.
    const largeBody = "{" + '"x":"' + "a".repeat(1_100_000) + '"}'
    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: largeBody,
    })
    expect(res.status).toBe(413)
  })

  test("GET /webhook returns 404 (only POST is handled)", async () => {
    const { port } = startTestServer()
    const res = await fetch(`http://127.0.0.1:${port}/webhook`)
    expect(res.status).toBe(404)
  })
})
