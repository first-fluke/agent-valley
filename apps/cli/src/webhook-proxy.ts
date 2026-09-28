import { createServer, request as httpRequest, type Server } from "node:http"

const WEBHOOK_PATHS = new Set(["/api/webhook", "/api/webhook/github"])
const MAX_BODY_BYTES = 1_048_576

export function dashboardHost(): string {
  const host = process.env.SYMPHONY_DASHBOARD_HOST ?? "127.0.0.1"
  if (
    !["127.0.0.1", "localhost", "::1", "[::1]"].includes(host) &&
    (!process.env.SYMPHONY_DASHBOARD_TOKEN || !process.env.SYMPHONY_INTERVENTION_TOKEN)
  ) {
    throw new Error(
      "A non-loopback SYMPHONY_DASHBOARD_HOST requires both SYMPHONY_DASHBOARD_TOKEN and SYMPHONY_INTERVENTION_TOKEN.",
    )
  }
  return host
}

export function dashboardTargetHost(): string {
  const host = process.env.SYMPHONY_DASHBOARD_HOST ?? "127.0.0.1"
  return host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host.replace(/^\[(.*)\]$/, "$1")
}

export function webhookPort(dashboardPort: string): string {
  const port = Number(process.env.SYMPHONY_WEBHOOK_PORT ?? Number(dashboardPort) + 1)
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === Number(dashboardPort)) {
    throw new Error("Set SYMPHONY_WEBHOOK_PORT to a valid port different from SERVER_PORT.")
  }
  return String(port)
}

/** Public tunnel target. Only signed tracker webhooks can reach the dashboard. */
export function startWebhookProxy(dashboardPort: string, publicPort: string): Promise<Server> {
  dashboardHost()
  const upstreamHost = dashboardTargetHost()
  const headerHost = upstreamHost.includes(":") ? `[${upstreamHost}]` : upstreamHost
  const server = createServer((incoming, outgoing) => {
    if (incoming.method !== "POST" || !WEBHOOK_PATHS.has(incoming.url ?? "")) {
      outgoing.writeHead(404).end()
      return
    }
    if (Number(incoming.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
      outgoing.writeHead(413).end()
      return
    }
    const upstream = httpRequest(
      {
        hostname: upstreamHost,
        port: Number(dashboardPort),
        path: incoming.url,
        method: "POST",
        headers: { ...incoming.headers, host: `${headerHost}:${dashboardPort}` },
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(outgoing)
      },
    )
    upstream.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502)
      outgoing.end()
    })
    let bytes = 0
    incoming.on("data", (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        upstream.destroy()
        if (!outgoing.headersSent) outgoing.writeHead(413)
        outgoing.end()
        incoming.destroy()
      }
    })
    incoming.pipe(upstream)
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(Number(publicPort), "127.0.0.1", () => {
      server.off("error", reject)
      resolve(server)
    })
  })
}
