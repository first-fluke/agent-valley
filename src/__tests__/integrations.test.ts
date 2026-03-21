/**
 * Integrations tests — IntegrationDispatcher, GitHubIntegration, SlackIntegration, factory.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test"
import type { IntegrationEvent } from "../domain/models"
import {
  IntegrationDispatcher,
  GitHubIntegration,
  SlackIntegration,
  createIntegrationDispatcher,
} from "../integrations"
import type { Integration } from "../integrations"

// ── Test helper ──────────────────────────────────────────────────────

function sampleEvent(overrides: Partial<IntegrationEvent> = {}): IntegrationEvent {
  return {
    kind: "agent_completed",
    issueId: "issue-1",
    issueIdentifier: "FIR-3",
    issueTitle: "Test issue",
    issueUrl: "https://linear.app/team/FIR-3",
    workspacePath: "/tmp/workspace",
    timestamp: new Date().toISOString(),
    detail: null,
    ...overrides,
  }
}

// ── IntegrationDispatcher ────────────────────────────────────────────

describe("IntegrationDispatcher", () => {
  function makeStubIntegration(type: string, notifyImpl?: () => Promise<void>): Integration {
    return {
      type,
      status: () => ({ type: type as "github" | "slack", configured: true, lastEventAt: null, error: null }),
      notify: notifyImpl ?? (() => Promise.resolve()),
    }
  }

  test("count returns number of integrations", () => {
    const dispatcher = new IntegrationDispatcher([
      makeStubIntegration("github"),
      makeStubIntegration("slack"),
    ])
    expect(dispatcher.count).toBe(2)
  })

  test("count is 0 when no integrations", () => {
    const dispatcher = new IntegrationDispatcher([])
    expect(dispatcher.count).toBe(0)
  })

  test("statuses() returns status from each integration", () => {
    const a = makeStubIntegration("github")
    const b = makeStubIntegration("slack")
    const dispatcher = new IntegrationDispatcher([a, b])
    const statuses = dispatcher.statuses()
    expect(statuses).toHaveLength(2)
    expect(statuses[0]!.type).toBe("github")
    expect(statuses[1]!.type).toBe("slack")
    expect(statuses[0]!.configured).toBe(true)
  })

  test("dispatch() calls notify() on all integrations", async () => {
    const calls: string[] = []
    const a = makeStubIntegration("github", async () => { calls.push("github") })
    const b = makeStubIntegration("slack", async () => { calls.push("slack") })
    const dispatcher = new IntegrationDispatcher([a, b])
    await dispatcher.dispatch(sampleEvent())
    expect(calls).toContain("github")
    expect(calls).toContain("slack")
    expect(calls).toHaveLength(2)
  })

  test("dispatch() does not throw when an integration's notify() rejects", async () => {
    const failing = makeStubIntegration("github", async () => {
      throw new Error("network failure")
    })
    const dispatcher = new IntegrationDispatcher([failing])
    await expect(dispatcher.dispatch(sampleEvent())).resolves.toBeUndefined()
  })

  test("dispatch() continues notifying remaining integrations when one fails", async () => {
    const calls: string[] = []
    const failing = makeStubIntegration("github", async () => {
      throw new Error("github down")
    })
    const succeeding = makeStubIntegration("slack", async () => { calls.push("slack") })
    const dispatcher = new IntegrationDispatcher([failing, succeeding])
    await dispatcher.dispatch(sampleEvent())
    expect(calls).toContain("slack")
  })
})

// ── GitHubIntegration ────────────────────────────────────────────────

describe("GitHubIntegration", () => {
  const config = { token: "ghp_test", owner: "acme", repo: "my-repo" }
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("type is 'github'", () => {
    const integration = new GitHubIntegration(config)
    expect(integration.type).toBe("github")
  })

  test("status() returns configured: true with initial null lastEventAt and error", () => {
    const integration = new GitHubIntegration(config)
    const status = integration.status()
    expect(status.configured).toBe(true)
    expect(status.type).toBe("github")
    expect(status.lastEventAt).toBeNull()
    expect(status.error).toBeNull()
  })

  test("notify() does not throw on fetch failure", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("network error"))) as any
    const integration = new GitHubIntegration(config)
    await expect(integration.notify(sampleEvent())).resolves.toBeUndefined()
  })

  test("notify() updates lastEventAt on success", async () => {
    const pr = { number: 42, head: { ref: "fir-3-test-issue" } }
    // First call: search by head branch — returns matching PR
    // Second call: post comment — returns 201
    let callCount = 0
    globalThis.fetch = mock(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve(new Response(JSON.stringify([pr]), { status: 200 }))
      }
      // post comment
      return Promise.resolve(new Response(JSON.stringify({ id: 1 }), { status: 201 }))
    }) as any

    const event = sampleEvent()
    const integration = new GitHubIntegration(config)
    await integration.notify(event)
    expect(integration.status().lastEventAt).toBe(event.timestamp)
  })

  test("notify() updates lastError on fetch failure", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("connection refused"))) as any
    const integration = new GitHubIntegration(config)
    await integration.notify(sampleEvent())
    expect(integration.status().error).toBe("connection refused")
  })

  test("notify() updates lastError on non-ok API response", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Unauthorized", { status: 401 }))
    ) as any
    const integration = new GitHubIntegration(config)
    await integration.notify(sampleEvent())
    expect(integration.status().error).not.toBeNull()
    expect(integration.status().error).toContain("401")
  })

  test("status() reflects lastError after failed notify", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("timeout"))) as any
    const integration = new GitHubIntegration(config)
    const before = integration.status()
    expect(before.error).toBeNull()
    await integration.notify(sampleEvent())
    const after = integration.status()
    expect(after.error).toBe("timeout")
  })
})

// ── SlackIntegration ─────────────────────────────────────────────────

describe("SlackIntegration", () => {
  const config = { webhookUrl: "https://hooks.slack.com/services/TEST/HOOK" }
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("type is 'slack'", () => {
    const integration = new SlackIntegration(config)
    expect(integration.type).toBe("slack")
  })

  test("status() returns configured: true with initial null lastEventAt and error", () => {
    const integration = new SlackIntegration(config)
    const status = integration.status()
    expect(status.configured).toBe(true)
    expect(status.type).toBe("slack")
    expect(status.lastEventAt).toBeNull()
    expect(status.error).toBeNull()
  })

  test("notify() sends POST to webhook URL with correct payload format", async () => {
    let capturedRequest: Request | null = null
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      capturedRequest = new Request(input as string, init)
      return Promise.resolve(new Response("ok", { status: 200 }))
    }) as any

    const event = sampleEvent({ kind: "agent_completed", detail: "All done" })
    const integration = new SlackIntegration(config)
    await integration.notify(event)

    expect(capturedRequest).not.toBeNull()
    expect(capturedRequest!.method).toBe("POST")
    expect(capturedRequest!.url).toBe(config.webhookUrl)

    const body = JSON.parse(await capturedRequest!.text())
    expect(body).toHaveProperty("attachments")
    expect(Array.isArray(body.attachments)).toBe(true)
    expect(body.attachments[0]).toHaveProperty("blocks")
    expect(body.attachments[0]).toHaveProperty("color")
  })

  test("notify() does not throw on fetch failure", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("network error"))) as any
    const integration = new SlackIntegration(config)
    await expect(integration.notify(sampleEvent())).resolves.toBeUndefined()
  })

  test("notify() updates lastEventAt on success", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("ok", { status: 200 }))
    ) as any
    const event = sampleEvent()
    const integration = new SlackIntegration(config)
    await integration.notify(event)
    expect(integration.status().lastEventAt).toBe(event.timestamp)
  })

  test("notify() updates lastError on failure response", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("invalid_payload", { status: 400, statusText: "Bad Request" }))
    ) as any
    const integration = new SlackIntegration(config)
    await integration.notify(sampleEvent())
    expect(integration.status().error).not.toBeNull()
    expect(integration.status().error).toContain("400")
  })

  test("notify() updates lastError on fetch throw", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("connection refused"))) as any
    const integration = new SlackIntegration(config)
    await integration.notify(sampleEvent())
    expect(integration.status().error).toBe("connection refused")
  })
})

// ── createIntegrationDispatcher factory ──────────────────────────────

describe("createIntegrationDispatcher", () => {
  test("returns dispatcher with 0 integrations when no config", () => {
    const dispatcher = createIntegrationDispatcher({})
    expect(dispatcher.count).toBe(0)
  })

  test("returns dispatcher with 1 integration when only github configured", () => {
    const dispatcher = createIntegrationDispatcher({
      github: { token: "ghp_test", owner: "acme", repo: "my-repo" },
    })
    expect(dispatcher.count).toBe(1)
    expect(dispatcher.statuses()[0]!.type).toBe("github")
  })

  test("returns dispatcher with 1 integration when only slack configured", () => {
    const dispatcher = createIntegrationDispatcher({
      slack: { webhookUrl: "https://hooks.slack.com/services/TEST/HOOK" },
    })
    expect(dispatcher.count).toBe(1)
    expect(dispatcher.statuses()[0]!.type).toBe("slack")
  })

  test("returns dispatcher with 2 integrations when both configured", () => {
    const dispatcher = createIntegrationDispatcher({
      github: { token: "ghp_test", owner: "acme", repo: "my-repo" },
      slack: { webhookUrl: "https://hooks.slack.com/services/TEST/HOOK" },
    })
    expect(dispatcher.count).toBe(2)
    const types = dispatcher.statuses().map((s) => s.type)
    expect(types).toContain("github")
    expect(types).toContain("slack")
  })
})
