import { createServer } from "node:http"
import { afterEach, describe, expect, test } from "vitest"
import { dashboardHost, startWebhookProxy } from "./webhook-proxy"

const oldHost = process.env.SYMPHONY_DASHBOARD_HOST
const oldDashboardToken = process.env.SYMPHONY_DASHBOARD_TOKEN
const oldInterventionToken = process.env.SYMPHONY_INTERVENTION_TOKEN
afterEach(() => {
  for (const [key, value] of [
    ["SYMPHONY_DASHBOARD_HOST", oldHost],
    ["SYMPHONY_DASHBOARD_TOKEN", oldDashboardToken],
    ["SYMPHONY_INTERVENTION_TOKEN", oldInterventionToken],
  ] as Array<[string, string | undefined]>) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe("webhook-only tunnel listener", () => {
  test("defaults to loopback and refuses unauthenticated remote binding", () => {
    delete process.env.SYMPHONY_DASHBOARD_HOST
    delete process.env.SYMPHONY_DASHBOARD_TOKEN
    delete process.env.SYMPHONY_INTERVENTION_TOKEN
    expect(dashboardHost()).toBe("127.0.0.1")
    process.env.SYMPHONY_DASHBOARD_HOST = "0.0.0.0"
    expect(() => dashboardHost()).toThrow(/both SYMPHONY_DASHBOARD_TOKEN/)
    process.env.SYMPHONY_DASHBOARD_TOKEN = "status"
    process.env.SYMPHONY_INTERVENTION_TOKEN = "action"
    expect(dashboardHost()).toBe("0.0.0.0")
  })

  test("forwards signed webhook path and blocks every control path", async () => {
    const upstream = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/plain" })
      response.end(`${request.url}:${request.headers["linear-signature"]}`)
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const upstreamPort = (upstream.address() as { port: number }).port
    const proxy = await startWebhookProxy(String(upstreamPort), "0")
    const proxyPort = (proxy.address() as { port: number }).port
    try {
      const webhook = await fetch(`http://127.0.0.1:${proxyPort}/api/webhook`, {
        method: "POST",
        headers: { "linear-signature": "signed" },
        body: "{}",
      })
      expect(webhook.status).toBe(200)
      expect(await webhook.text()).toBe("/api/webhook:signed")
      for (const path of [
        "/",
        "/api/status",
        "/api/events",
        "/api/intervention",
        "/api/auth/session",
        "/api/webhook/extra",
      ]) {
        expect((await fetch(`http://127.0.0.1:${proxyPort}${path}`)).status).toBe(404)
      }
      const forged = await fetch(`http://127.0.0.1:${proxyPort}/api/status`, {
        headers: { host: "localhost" },
      })
      expect(forged.status).toBe(404)
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })
})
