import { createServer } from "node:http"
import { afterEach, describe, expect, test } from "vitest"
import { readStatus } from "./status-client"

const oldToken = process.env.SYMPHONY_DASHBOARD_TOKEN
const oldHost = process.env.SYMPHONY_DASHBOARD_HOST
afterEach(() => {
  if (oldToken === undefined) delete process.env.SYMPHONY_DASHBOARD_TOKEN
  else process.env.SYMPHONY_DASHBOARD_TOKEN = oldToken
  if (oldHost === undefined) delete process.env.SYMPHONY_DASHBOARD_HOST
  else process.env.SYMPHONY_DASHBOARD_HOST = oldHost
})

describe("CLI status client", () => {
  test("sends the configured bearer token and rejects a wrong token", async () => {
    delete process.env.SYMPHONY_DASHBOARD_HOST
    const server = createServer((request, response) => {
      if (request.url !== "/api/status") {
        response.writeHead(404).end()
      } else if (request.headers.authorization !== "Bearer correct") {
        response.writeHead(401).end(JSON.stringify({ error: "Unauthorized" }))
      } else {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ activeAgents: 2 }))
      }
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = String((server.address() as { port: number }).port)
    try {
      process.env.SYMPHONY_DASHBOARD_TOKEN = "correct"
      expect(await readStatus(port)).toEqual({ activeAgents: 2 })
      process.env.SYMPHONY_DASHBOARD_TOKEN = "wrong"
      await expect(readStatus(port)).rejects.toThrow(/denied status \(401\)/)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
