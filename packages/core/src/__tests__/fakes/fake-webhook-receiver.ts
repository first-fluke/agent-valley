/**
 * FakeWebhookReceiver — WebhookReceiver stub with a toggleable signature
 * verdict and a pre-set next parsed event.
 */

import type { WebhookReceiver } from "../../domain/ports/tracker"

/**
 * Three verification modes:
 *   - "always-valid" (default): always returns true
 *   - "always-invalid": always returns false
 *   - "match": returns true only when the incoming signature equals `expectedSignature`
 */
export type FakeWebhookVerificationMode = "always-valid" | "always-invalid" | "match"

export class FakeWebhookReceiver<TEvent = unknown> implements WebhookReceiver<TEvent> {
  public verificationMode: FakeWebhookVerificationMode = "always-valid"
  public expectedSignature = ""
  public nextEvent: TEvent | null = null

  public readonly verifyCalls: Array<{ payload: string; signature: string }> = []
  public readonly parseCalls: string[] = []

  /** Back-compat toggle: sets mode to always-valid or always-invalid. */
  set signatureValid(valid: boolean) {
    this.verificationMode = valid ? "always-valid" : "always-invalid"
  }

  async verifySignature(payload: string, signature: string): Promise<boolean> {
    this.verifyCalls.push({ payload, signature })
    switch (this.verificationMode) {
      case "always-valid":
        return true
      case "always-invalid":
        return false
      case "match":
        return signature === this.expectedSignature
    }
  }

  parseEvent(payload: string): TEvent | null {
    this.parseCalls.push(payload)
    return this.nextEvent
  }
}
