import { describe, expect, test } from "vitest"
import { readBoundedBody } from "./request-body"

describe("readBoundedBody", () => {
  test("reads a body within the cap", async () => {
    const request = new Request("http://localhost/api/webhook", { method: "POST", body: "hello" })

    await expect(readBoundedBody(request, 16)).resolves.toEqual({ ok: true, text: "hello" })
  })

  test("rejects a body that grows past the cap", async () => {
    const request = new Request("http://localhost/api/webhook", { method: "POST", body: "x".repeat(4096) })

    await expect(readBoundedBody(request, 1024)).resolves.toEqual({ ok: false, status: 413 })
  })

  test("rejects a declared length above the cap before reading", async () => {
    const request = new Request("http://localhost/api/webhook", {
      method: "POST",
      headers: { "content-length": String(2_000_000) },
      body: "ignored",
    })

    await expect(readBoundedBody(request, 1024)).resolves.toEqual({ ok: false, status: 413 })
  })
})
