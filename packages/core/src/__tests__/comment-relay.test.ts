/**
 * CommentRelay unit tests — which issue comments reach a running actor.
 */

import { describe, expect, test, vi } from "vitest"
import type { CommentRelayCore, IssueCommentEvent } from "../orchestrator/comment-relay"
import { relayIssueComment } from "../orchestrator/comment-relay"
import type { InterventionResult } from "../orchestrator/intervention-bus"
import { makeConfig } from "./characterization/helpers"

function comment(overrides: Partial<IssueCommentEvent> = {}): IssueCommentEvent {
  return {
    kind: "issue.commented",
    issueId: "42",
    commentId: "9001",
    author: "maintainer",
    authorKeys: ["maintainer"],
    authorTrust: "maintainer",
    fromAgentValley: false,
    body: "Please also handle the empty state.",
    ...overrides,
  }
}

function harness(options: {
  enabled?: boolean
  ignoreAuthors?: string[]
  attemptId?: string
  result?: InterventionResult
  withRelayConfig?: boolean
}) {
  const send = vi.fn(async () => options.result ?? ({ ok: true } as InterventionResult))
  const config = makeConfig(
    options.withRelayConfig === false
      ? {}
      : {
          commentRelay: {
            enabled: options.enabled ?? true,
            ignoreAuthors: options.ignoreAuthors ?? [],
            pullRequestReviews: false,
          },
        },
  )
  const core = {
    config,
    getAttempt: (issueId: string) => (issueId === "42" ? options.attemptId : undefined),
    getInterventionBus: () => ({ send }),
  } as unknown as CommentRelayCore
  return { core, send }
}

describe("relayIssueComment", () => {
  test("relays a maintainer comment into the running attempt", async () => {
    const { core, send } = harness({ attemptId: "att-1" })

    const outcome = await relayIssueComment(core, comment())

    expect(outcome).toEqual({ relayed: true, attemptId: "att-1" })
    expect(send).toHaveBeenCalledWith("att-1", {
      kind: "append_prompt",
      text: "Issue comment from @maintainer:\nPlease also handle the empty state.",
    })
  })

  test("does nothing while comment relay is off or unconfigured", async () => {
    for (const options of [{ enabled: false }, { withRelayConfig: false }]) {
      const { core, send } = harness({ attemptId: "att-1", ...options })
      expect(await relayIssueComment(core, comment())).toEqual({ relayed: false, reason: "disabled" })
      expect(send).not.toHaveBeenCalled()
    }
  })

  test("drops Agent Valley's own comments", async () => {
    const { core, send } = harness({ attemptId: "att-1" })
    expect(await relayIssueComment(core, comment({ fromAgentValley: true }))).toEqual({
      relayed: false,
      reason: "own_comment",
    })
    expect(send).not.toHaveBeenCalled()
  })

  test("drops external and bot authors", async () => {
    const { core, send } = harness({ attemptId: "att-1" })
    for (const authorTrust of ["external", "bot"] as const) {
      expect(await relayIssueComment(core, comment({ authorTrust }))).toEqual({
        relayed: false,
        reason: "untrusted_author",
      })
    }
    expect(send).not.toHaveBeenCalled()
  })

  test("drops configured authors by any of their keys, case-insensitively", async () => {
    const { core, send } = harness({ attemptId: "att-1", ignoreAuthors: ["Release-Bot", "ops@example.com"] })
    for (const authorKeys of [["release-bot"], ["Ops@Example.com", "user-1", "Ops"]]) {
      expect(await relayIssueComment(core, comment({ author: "someone", authorKeys }))).toEqual({
        relayed: false,
        reason: "ignored_author",
      })
    }
    expect(send).not.toHaveBeenCalled()
  })

  test("drops comments on issues without a running attempt", async () => {
    const { core, send } = harness({})
    expect(await relayIssueComment(core, comment())).toEqual({ relayed: false, reason: "no_running_attempt" })
    expect(send).not.toHaveBeenCalled()
  })

  test("drops empty comments", async () => {
    const { core, send } = harness({ attemptId: "att-1" })
    expect(await relayIssueComment(core, comment({ body: "  \n" }))).toEqual({ relayed: false, reason: "empty" })
    expect(send).not.toHaveBeenCalled()
  })

  test("reports a bus rejection without throwing", async () => {
    const { core } = harness({
      attemptId: "att-1",
      result: { ok: false, reason: "terminated", message: "attempt already ended" },
    })
    expect(await relayIssueComment(core, comment())).toEqual({ relayed: false, reason: "rejected" })
  })
})
