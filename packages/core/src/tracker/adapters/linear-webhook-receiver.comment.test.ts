/**
 * LinearWebhookReceiver comment tests — Comment webhooks map to the domain
 * `issue.commented` event through the real `parseWebhookEvent`.
 */
import { describe, expect, test } from "vitest"
import { LinearWebhookReceiver } from "./linear-webhook-receiver"

function commentPayload(overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "Comment",
    action: "create",
    actor: { id: "user-1", type: "user", name: "Dana", email: "dana@example.com" },
    data: {
      id: "comment-1",
      body: "Please also cover the empty state.",
      issueId: "issue-123",
      userId: "user-1",
      ...data,
    },
    webhookTimestamp: Date.now(),
    ...overrides,
  })
}

describe("LinearWebhookReceiver — comments", () => {
  test("maps a new user comment on an issue to issue.commented", () => {
    const ev = new LinearWebhookReceiver({ secret: "whsec" }).parseEvent(commentPayload())
    expect(ev).toEqual({
      kind: "issue.commented",
      issueId: "issue-123",
      commentId: "comment-1",
      author: "Dana",
      authorKeys: ["dana@example.com", "user-1", "Dana"],
      authorTrust: "maintainer",
      fromAgentValley: false,
      body: "Please also cover the empty state.",
    })
  })

  test("treats OAuth clients, integrations and deleted actors as bots", () => {
    const receiver = new LinearWebhookReceiver({ secret: "whsec" })
    const app = receiver.parseEvent(commentPayload({ actor: { id: "app-1", type: "oauthClient", name: "Zapier" } }))
    expect(app).toMatchObject({ kind: "issue.commented", authorTrust: "bot" })

    const deleted = receiver.parseEvent(commentPayload({ actor: null }, { id: "comment-2" }))
    expect(deleted).toMatchObject({ kind: "issue.commented", authorTrust: "bot", authorKeys: ["user-1"] })
  })

  test("recognizes Agent Valley's own comments by their prefix", () => {
    const ev = new LinearWebhookReceiver({ secret: "whsec" }).parseEvent(
      commentPayload({}, { body: "Symphony: Received — starting agent for ACR-42" }),
    )
    expect(ev).toMatchObject({ kind: "issue.commented", fromAgentValley: true })
  })

  test("ignores edits, removals and comments outside issues", () => {
    const receiver = new LinearWebhookReceiver({ secret: "whsec" })
    expect(receiver.parseEvent(commentPayload({ action: "update" }))).toBeNull()
    expect(receiver.parseEvent(commentPayload({ action: "remove" }, { id: "comment-3" }))).toBeNull()
    expect(receiver.parseEvent(commentPayload({}, { id: "comment-4", issueId: null }))).toBeNull()
  })

  test("rejects a replayed comment delivery", () => {
    const receiver = new LinearWebhookReceiver({ secret: "whsec" })
    const payload = commentPayload()
    expect(receiver.parseEvent(payload)).not.toBeNull()
    expect(receiver.parseEvent(payload)).toBeNull()
  })
})
