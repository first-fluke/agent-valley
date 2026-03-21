/**
 * HTTP Server — Bun.serve for webhooks, status, and health.
 */

import { logger } from "../observability/logger"

export interface WebhookHandlerFn {
  (payload: string, signature: string): Promise<{ status: number; body: string }>
}

export interface GitHubWebhookHandlerFn {
  (payload: string, signature: string, eventType: string): Promise<{ status: number; body: string }>
}

export interface StatusFn {
  (): Record<string, unknown>
}

export function startHttpServer(
  port: number,
  handlers: {
    onWebhook: WebhookHandlerFn
    getStatus: StatusFn
    onGitHubWebhook?: GitHubWebhookHandlerFn
  },
): { stop: () => void } {
  const MAX_PAYLOAD_SIZE = 1_048_576 // 1MB

  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",  // Bind to all interfaces (IPv4 + IPv6)
    async fetch(req) {
      try {
        const url = new URL(req.url)

        // POST /webhook
        if (req.method === "POST" && url.pathname === "/webhook") {
          // Content-Type validation
          const contentType = req.headers.get("content-type") ?? ""
          if (!contentType.includes("application/json")) {
            return Response.json(
              { error: "Unsupported content type. Expected application/json" },
              { status: 415 },
            )
          }

          // Request body size limit — check Content-Length header first
          const contentLength = req.headers.get("content-length")
          if (contentLength && parseInt(contentLength, 10) > MAX_PAYLOAD_SIZE) {
            return Response.json(
              { error: "Payload too large" },
              { status: 413 },
            )
          }

          const payload = await req.text()

          // Also check actual body length after reading
          if (payload.length > MAX_PAYLOAD_SIZE) {
            return Response.json(
              { error: "Payload too large" },
              { status: 413 },
            )
          }

          const signature = req.headers.get("linear-signature") ?? ""

          const result = await handlers.onWebhook(payload, signature)
          return new Response(result.body, {
            status: result.status,
            headers: { "Content-Type": "application/json" },
          })
        }

        // POST /webhook/github
        if (req.method === "POST" && url.pathname === "/webhook/github") {
          if (!handlers.onGitHubWebhook) {
            return Response.json(
              { error: "GitHub webhook sync not configured. Set GITHUB_WEBHOOK_SECRET in .env" },
              { status: 501 },
            )
          }

          const contentType = req.headers.get("content-type") ?? ""
          if (!contentType.includes("application/json")) {
            return Response.json(
              { error: "Unsupported content type. Expected application/json" },
              { status: 415 },
            )
          }

          const contentLength = req.headers.get("content-length")
          if (contentLength && parseInt(contentLength, 10) > MAX_PAYLOAD_SIZE) {
            return Response.json({ error: "Payload too large" }, { status: 413 })
          }

          const payload = await req.text()
          if (payload.length > MAX_PAYLOAD_SIZE) {
            return Response.json({ error: "Payload too large" }, { status: 413 })
          }

          const signature = req.headers.get("x-hub-signature-256") ?? ""
          const eventType = req.headers.get("x-github-event") ?? ""

          const result = await handlers.onGitHubWebhook(payload, signature, eventType)
          return new Response(result.body, {
            status: result.status,
            headers: { "Content-Type": "application/json" },
          })
        }

        // GET /status
        if (req.method === "GET" && url.pathname === "/status") {
          const status = handlers.getStatus()
          return Response.json(status)
        }

        // GET /health
        if (req.method === "GET" && url.pathname === "/health") {
          return Response.json({ status: "ok" })
        }

        return Response.json({ error: "Not found" }, { status: 404 })
      } catch (err) {
        logger.error("http-server", `Unhandled error in request handler: ${err instanceof Error ? err.message : String(err)}`)
        return Response.json({ error: "Internal server error" }, { status: 500 })
      }
    },
  })

  logger.info("http-server", `Server listening on port ${port}`)

  return {
    stop: () => server.stop(),
  }
}
