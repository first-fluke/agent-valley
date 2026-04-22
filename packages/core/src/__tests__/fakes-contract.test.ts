/**
 * Run the port contract suites against the in-memory fakes. If any of
 * these fail, the fakes themselves are broken — which would poison every
 * unit test that relies on them.
 */
import { describe, expect, test } from "vitest"
import type { ParsedWebhookEvent } from "../tracker/types"
import { runIssueTrackerContract } from "./contracts/issue-tracker.contract"
import { runWebhookReceiverContract } from "./contracts/webhook-receiver.contract"
import { runWorkspaceGatewayContract } from "./contracts/workspace-gateway.contract"
import { FakeIssueTracker } from "./fakes/fake-tracker"
import { FakeWebhookReceiver } from "./fakes/fake-webhook-receiver"
import { FakeWorkspaceGateway } from "./fakes/fake-workspace-gateway"

// ── IssueTracker ───────────────────────────────────────────────────

runIssueTrackerContract("FakeIssueTracker", async () => {
  const tracker = new FakeIssueTracker()
  return {
    tracker,
    seedIssue: async (issue) => {
      tracker.seedIssue(issue)
      return issue.id
    },
  }
})

// ── WebhookReceiver ─────────────────────────────────────────────────

runWebhookReceiverContract<ParsedWebhookEvent>("FakeWebhookReceiver", async () => {
  const receiver = new FakeWebhookReceiver<ParsedWebhookEvent>()
  receiver.verificationMode = "match"
  receiver.expectedSignature = "good-sig"
  receiver.nextEvent = null
  return {
    receiver,
    validPayload: "{}",
    validSignature: "good-sig",
    tamperedSignature: "bad-sig",
    nonDomainPayload: "{}",
    // No domainPayload: positive-case parse coverage lives in webhook-handler.test.ts.
  }
})

// Direct coverage for the helper modes the fake exposes.
describe("FakeWebhookReceiver — modes", () => {
  test("always-invalid mode returns false regardless of signature", async () => {
    const receiver = new FakeWebhookReceiver<ParsedWebhookEvent>()
    receiver.signatureValid = false
    const verdict = await receiver.verifySignature("{}", "any")
    expect(verdict).toBe(false)
  })

  test("parseEvent returns the pre-set nextEvent", () => {
    const receiver = new FakeWebhookReceiver<{ x: number }>()
    receiver.nextEvent = { x: 42 }
    expect(receiver.parseEvent("irrelevant")).toEqual({ x: 42 })
  })
})

// ── WorkspaceGateway ────────────────────────────────────────────────

runWorkspaceGatewayContract("FakeWorkspaceGateway", async () => {
  let currentDirty = false
  const gateway = new FakeWorkspaceGateway({
    unfinished: { hasUncommittedChanges: false, hasCodeChanges: false },
  })
  return {
    gateway,
    setChanges: async (_issueId, hasChanges) => {
      currentDirty = hasChanges
      gateway.unfinished = {
        hasUncommittedChanges: currentDirty,
        hasCodeChanges: currentDirty,
      }
    },
  }
})
