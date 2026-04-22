/**
 * WebhookReceiver contract suite — reusable across fakes and real adapters.
 *
 * The suite is generic: the caller supplies a harness that produces a
 * receiver plus raw `(payload, signature)` samples that should be valid
 * for that receiver's signing scheme, and a payload string that must
 * parse to `null` (non-domain event).
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 4.6
 */

import { describe, expect, test } from "vitest"
import type { WebhookReceiver } from "../../domain/ports/tracker"

export interface WebhookReceiverContractSample<TEvent> {
  receiver: WebhookReceiver<TEvent>
  /** A payload + signature pair that must verify for `receiver`. */
  validPayload: string
  validSignature: string
  /** A signature string that must NOT verify for `validPayload`. */
  tamperedSignature: string
  /** A payload the receiver should return `null` for (non-domain event). */
  nonDomainPayload: string
  /** An optional payload + event assertion for parseEvent positive case. */
  domainPayload?: string
  assertDomainEvent?: (event: TEvent | null) => void
}

export function runWebhookReceiverContract<TEvent>(
  label: string,
  makeSample: () => Promise<WebhookReceiverContractSample<TEvent>>,
): void {
  describe(`WebhookReceiver contract — ${label}`, () => {
    test("verifySignature returns true for a correctly signed payload", async () => {
      const { receiver, validPayload, validSignature } = await makeSample()
      await expect(receiver.verifySignature(validPayload, validSignature)).resolves.toBe(true)
    })

    test("verifySignature returns false when the signature is tampered", async () => {
      const { receiver, validPayload, tamperedSignature } = await makeSample()
      await expect(receiver.verifySignature(validPayload, tamperedSignature)).resolves.toBe(false)
    })

    test("parseEvent returns null for a non-domain payload", async () => {
      const { receiver, nonDomainPayload } = await makeSample()
      expect(receiver.parseEvent(nonDomainPayload)).toBeNull()
    })

    test("parseEvent returns an event for a domain payload", async () => {
      const sample = await makeSample()
      if (!sample.domainPayload || !sample.assertDomainEvent) return
      const event = sample.receiver.parseEvent(sample.domainPayload)
      sample.assertDomainEvent(event)
    })
  })
}
