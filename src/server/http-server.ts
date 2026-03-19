/**
 * HTTP Server — Bun.serve for webhooks, status, and health.
 */

import { logger } from "../observability/logger"

export interface WebhookHandlerFn {
  (payload: string, signature: string): Promise<{ status: number; body: string }>
}

export interface StatusFn {
  (): Record<string, unknown>
}

export function startHttpServer(
  port: number,
  handlers: {
    onWebhook: WebhookHandlerFn
    getStatus: StatusFn
  },
): { stop: () => void; port: number } {
  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",  // Bind to all interfaces (IPv4 + IPv6)
    async fetch(req) {
      const url = new URL(req.url)

      // POST /webhook
      if (req.method === "POST" && url.pathname === "/webhook") {
        const payload = await req.text()
        const signature = req.headers.get("linear-signature") ?? ""

        const result = await handlers.onWebhook(payload, signature)
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

      return new Response("Not Found", { status: 404 })
    },
  })

  logger.info("orchestrator", `Server listening on port ${server.port}`)

  return {
    stop: () => server.stop(),
    port: server.port,
  }
}
