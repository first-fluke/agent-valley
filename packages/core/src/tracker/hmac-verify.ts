/**
 * Shared constant-time HMAC-SHA256 verification for webhook signatures.
 *
 * Used by both the Linear (`webhook-handler.ts`) and GitHub
 * (`adapters/github-webhook-receiver.ts`) receivers so the comparison
 * logic — and its constant-time guarantee — lives in exactly one place.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto"

/**
 * Verify `providedHex` against the HMAC-SHA256 of `payload` keyed by
 * `secret`, encoded as lowercase hex.
 *
 * Both the expected and provided values are SHA-256 hashed before the
 * final comparison. This has two effects:
 *   1. `timingSafeEqual` requires equal-length buffers or it throws — an
 *      attacker who controls `providedHex` could otherwise trigger a
 *      thrown error (or force us into a length-guard branch whose
 *      early-return timing leaks how close `providedHex.length` is to
 *      the expected length). Hashing first makes both buffers a fixed
 *      32 bytes regardless of the input length, so no length branch is
 *      needed at all.
 *   2. The final comparison itself is constant-time via
 *      `crypto.timingSafeEqual`, replacing the previous hand-rolled
 *      `charCodeAt` XOR loop.
 */
export function verifyHmacSha256Hex(payload: string, providedHex: string, secret: string): boolean {
  if (!providedHex) return false

  const expectedHex = createHmac("sha256", secret).update(payload).digest("hex")
  const expectedDigest = createHash("sha256").update(expectedHex).digest()
  const providedDigest = createHash("sha256").update(providedHex).digest()

  return timingSafeEqual(expectedDigest, providedDigest)
}
