/**
 * hmac-verify tests — constant-time HMAC-SHA256 verification.
 */
import { createHmac } from "node:crypto"
import { describe, expect, test } from "vitest"
import { verifyHmacSha256Hex } from "./hmac-verify"

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex")
}

describe("verifyHmacSha256Hex", () => {
  const secret = "whsec_test_secret"

  test("valid signature returns true", () => {
    const payload = '{"a":1}'
    expect(verifyHmacSha256Hex(payload, sign(payload, secret), secret)).toBe(true)
  })

  test("tampered payload returns false", () => {
    const payload = '{"a":1}'
    const sig = sign(payload, secret)
    expect(verifyHmacSha256Hex('{"a":2}', sig, secret)).toBe(false)
  })

  test("wrong secret returns false", () => {
    const payload = '{"a":1}'
    const sig = sign(payload, "other-secret")
    expect(verifyHmacSha256Hex(payload, sig, secret)).toBe(false)
  })

  test("empty provided signature returns false", () => {
    expect(verifyHmacSha256Hex("{}", "", secret)).toBe(false)
  })

  test("shorter-than-expected provided signature does not throw and returns false", () => {
    // Regression: the old hand-rolled loop early-returned on length
    // mismatch; timingSafeEqual throws on unequal-length buffers if fed
    // raw hex directly. Hashing both sides first must avoid both.
    expect(() => verifyHmacSha256Hex("{}", "ab", secret)).not.toThrow()
    expect(verifyHmacSha256Hex("{}", "ab", secret)).toBe(false)
  })

  test("longer-than-expected provided signature does not throw and returns false", () => {
    const overlong = "a".repeat(500)
    expect(() => verifyHmacSha256Hex("{}", overlong, secret)).not.toThrow()
    expect(verifyHmacSha256Hex("{}", overlong, secret)).toBe(false)
  })

  test("empty payload with valid signature works", () => {
    const sig = sign("", secret)
    expect(verifyHmacSha256Hex("", sig, secret)).toBe(true)
  })
})
