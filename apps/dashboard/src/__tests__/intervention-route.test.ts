/**
 * /api/intervention route tests — verifies the 127.0.0.1 guard, body
 * validation, and InterventionBus delegation.
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 5.7, § 6.9.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

interface MockOrchestrator {
  intervention: {
    send: ReturnType<typeof vi.fn>
  }
}

let mockOrchestrator: MockOrchestrator | null = null

vi.mock("@/lib/orchestrator-singleton", () => ({
  getOrchestrator: () => mockOrchestrator,
}))

const { POST: interventionPOST } = await import("@/app/api/intervention/route")

function localRequest(body: unknown, host = "localhost"): Request {
  return new Request("http://localhost/api/intervention", {
    method: "POST",
    headers: { host, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function remoteRequest(body: unknown): Request {
  return new Request("http://example.com/api/intervention", {
    method: "POST",
    headers: { host: "example.com", "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /api/intervention", () => {
  beforeEach(() => {
    mockOrchestrator = {
      intervention: { send: vi.fn(async () => ({ ok: true })) },
    }
    delete process.env.SYMPHONY_ALLOW_REMOTE_INTERVENTION
  })

  afterEach(() => {
    mockOrchestrator = null
    delete process.env.SYMPHONY_ALLOW_REMOTE_INTERVENTION
  })

  test("returns 403 when the host is not localhost/127.0.0.1", async () => {
    const res = await interventionPOST(remoteRequest({ attemptId: "a", command: { kind: "pause" } }))
    expect(res.status).toBe(403)
    expect(mockOrchestrator?.intervention.send).not.toHaveBeenCalled()
  })

  test("allows remote when SYMPHONY_ALLOW_REMOTE_INTERVENTION=1", async () => {
    process.env.SYMPHONY_ALLOW_REMOTE_INTERVENTION = "1"
    const res = await interventionPOST(remoteRequest({ attemptId: "a", command: { kind: "pause" } }))
    expect(res.status).toBe(200)
    expect(mockOrchestrator?.intervention.send).toHaveBeenCalledWith("a", { kind: "pause" })
  })

  test("rejects malformed JSON with 400", async () => {
    const req = new Request("http://localhost/api/intervention", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: "{ not json",
    })
    const res = await interventionPOST(req)
    expect(res.status).toBe(400)
  })

  test("rejects missing attemptId with 400", async () => {
    const res = await interventionPOST(localRequest({ command: { kind: "pause" } }))
    expect(res.status).toBe(400)
  })

  test("rejects unknown command kind with 400", async () => {
    const res = await interventionPOST(localRequest({ attemptId: "a", command: { kind: "explode" } }))
    expect(res.status).toBe(400)
  })

  test("rejects append_prompt with empty text at the route layer", async () => {
    const res = await interventionPOST(
      localRequest({ attemptId: "a", command: { kind: "append_prompt", text: "" } }),
    )
    expect(res.status).toBe(400)
  })

  test("returns 503 when orchestrator is not initialized", async () => {
    mockOrchestrator = null
    const res = await interventionPOST(localRequest({ attemptId: "a", command: { kind: "pause" } }))
    expect(res.status).toBe(503)
  })

  test("happy path: delegates to bus.send and returns 200", async () => {
    const res = await interventionPOST(localRequest({ attemptId: "a1", command: { kind: "pause" } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(mockOrchestrator?.intervention.send).toHaveBeenCalledWith("a1", { kind: "pause" })
  })

  test("maps bus reasons to HTTP status codes", async () => {
    const cases: Array<[string, number]> = [
      ["unknown_attempt", 404],
      ["terminated", 409],
      ["unsupported", 422],
      ["invalid", 400],
    ]
    for (const [reason, expected] of cases) {
      mockOrchestrator = {
        intervention: {
          send: vi.fn(async () => ({ ok: false, reason, message: `${reason} failure` })),
        },
      }
      const res = await interventionPOST(localRequest({ attemptId: "a", command: { kind: "pause" } }))
      expect(res.status).toBe(expected)
      const body = await res.json()
      expect(body).toEqual({ ok: false, reason, message: `${reason} failure` })
    }
  })

  test("abort with default reason is accepted", async () => {
    const res = await interventionPOST(localRequest({ attemptId: "a1", command: { kind: "abort" } }))
    expect(res.status).toBe(200)
    expect(mockOrchestrator?.intervention.send).toHaveBeenCalledWith("a1", {
      kind: "abort",
      reason: "operator_requested",
    })
  })

  test("append_prompt with text is passed through", async () => {
    const res = await interventionPOST(
      localRequest({ attemptId: "a1", command: { kind: "append_prompt", text: "add tests" } }),
    )
    expect(res.status).toBe(200)
    expect(mockOrchestrator?.intervention.send).toHaveBeenCalledWith("a1", {
      kind: "append_prompt",
      text: "add tests",
    })
  })
})
