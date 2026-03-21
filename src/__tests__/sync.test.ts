/**
 * Sync tests — GitHub webhook handler, signature verification, event parsing, SyncService.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test"
import { verifyGitHubSignature, parseGitHubWebhookEvent } from "../sync/github-webhook-handler"
import { SyncService } from "../sync/sync-service"
import type { Config } from "../config/config"

// ── Test helpers ────────────────────────────────────────────────────

async function computeSignature(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload))
  return "sha256=" + Buffer.from(sig).toString("hex")
}

function makePrPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "closed",
    pull_request: {
      number: 42,
      title: "feat: add sync",
      html_url: "https://github.com/acme/repo/pull/42",
      merged: true,
      head: { ref: "symphony/FIR-4-import-data" },
    },
    ...overrides,
  })
}

function makeCheckSuitePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "completed",
    check_suite: {
      conclusion: "failure",
      head_branch: "symphony/FIR-4-import-data",
      pull_requests: [{ number: 42, url: "https://github.com/acme/repo/pull/42" }],
    },
    ...overrides,
  })
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    linearApiKey: "lin_api_test",
    linearTeamId: "FIR",
    linearTeamUuid: "team-uuid",
    linearWebhookSecret: "whsec_test",
    workflowStates: {
      todo: "state-todo",
      inProgress: "state-in-progress",
      done: "state-done",
      cancelled: "state-cancelled",
    },
    workspaceRoot: "/tmp/workspaces",
    agentType: "claude",
    agentTimeout: 3600,
    agentMaxRetries: 3,
    agentRetryDelay: 60,
    maxParallel: 3,
    serverPort: 9741,
    logLevel: "info",
    logFormat: "json",
    integrations: {
      github: {
        token: "ghp_test",
        owner: "acme",
        repo: "my-repo",
        webhookSecret: "test-webhook-secret",
      },
    },
    ...overrides,
  }
}

// ── verifyGitHubSignature ───────────────────────────────────────────

describe("verifyGitHubSignature", () => {
  const secret = "test-secret"
  const payload = '{"action":"opened"}'

  test("returns true for valid signature", async () => {
    const signature = await computeSignature(payload, secret)
    expect(await verifyGitHubSignature(payload, signature, secret)).toBe(true)
  })

  test("returns false for invalid signature", async () => {
    expect(await verifyGitHubSignature(payload, "sha256=invalid", secret)).toBe(false)
  })

  test("returns false for missing sha256= prefix", async () => {
    expect(await verifyGitHubSignature(payload, "invalid", secret)).toBe(false)
  })

  test("returns false for empty signature", async () => {
    expect(await verifyGitHubSignature(payload, "", secret)).toBe(false)
  })

  test("returns false for wrong secret", async () => {
    const signature = await computeSignature(payload, "wrong-secret")
    expect(await verifyGitHubSignature(payload, signature, secret)).toBe(false)
  })
})

// ── parseGitHubWebhookEvent ─────────────────────────────────────────

describe("parseGitHubWebhookEvent", () => {
  describe("pull_request events", () => {
    test("parses pr_merged event", () => {
      const payload = makePrPayload({ action: "closed" })
      const event = parseGitHubWebhookEvent(payload, "pull_request")
      expect(event).not.toBeNull()
      expect(event!.kind).toBe("pr_merged")
      expect(event!.issueIdentifier).toBe("FIR-4")
      expect(event!.prNumber).toBe(42)
      expect(event!.prTitle).toBe("feat: add sync")
      expect(event!.source).toBe("github")
    })

    test("parses pr_opened event", () => {
      const payload = makePrPayload({ action: "opened" })
      // Need to include merged: false for opened PRs
      const raw = JSON.parse(payload)
      raw.pull_request.merged = false
      const event = parseGitHubWebhookEvent(JSON.stringify(raw), "pull_request")
      expect(event).not.toBeNull()
      expect(event!.kind).toBe("pr_opened")
    })

    test("parses pr_closed (not merged) event", () => {
      const raw = JSON.parse(makePrPayload())
      raw.pull_request.merged = false
      const event = parseGitHubWebhookEvent(JSON.stringify(raw), "pull_request")
      expect(event).not.toBeNull()
      expect(event!.kind).toBe("pr_closed")
    })

    test("returns null for ignored PR actions (labeled, assigned)", () => {
      const payload = makePrPayload({ action: "labeled" })
      const event = parseGitHubWebhookEvent(payload, "pull_request")
      expect(event).toBeNull()
    })

    test("extracts issue identifier from branch name", () => {
      const raw = JSON.parse(makePrPayload())
      raw.pull_request.head.ref = "feature/ACR-123-some-feature"
      const event = parseGitHubWebhookEvent(JSON.stringify(raw), "pull_request")
      expect(event!.issueIdentifier).toBe("ACR-123")
    })

    test("returns null issueIdentifier for branches without issue key", () => {
      const raw = JSON.parse(makePrPayload())
      raw.pull_request.head.ref = "main"
      const event = parseGitHubWebhookEvent(JSON.stringify(raw), "pull_request")
      expect(event).not.toBeNull()
      expect(event!.issueIdentifier).toBeNull()
    })

    test("returns null for invalid payload", () => {
      const event = parseGitHubWebhookEvent("{}", "pull_request")
      expect(event).toBeNull()
    })
  })

  describe("check_suite events", () => {
    test("parses failed check suite event", () => {
      const payload = makeCheckSuitePayload()
      const event = parseGitHubWebhookEvent(payload, "check_suite")
      expect(event).not.toBeNull()
      expect(event!.kind).toBe("check_suite_completed")
      expect(event!.issueIdentifier).toBe("FIR-4")
      expect(event!.prNumber).toBe(42)
      expect(event!.detail).toContain("Check suite failed")
    })

    test("returns null for successful check suite", () => {
      const raw = JSON.parse(makeCheckSuitePayload())
      raw.check_suite.conclusion = "success"
      const event = parseGitHubWebhookEvent(JSON.stringify(raw), "check_suite")
      expect(event).toBeNull()
    })

    test("returns null for invalid check_suite payload", () => {
      const event = parseGitHubWebhookEvent("{}", "check_suite")
      expect(event).toBeNull()
    })
  })

  describe("unsupported events", () => {
    test("returns null for unsupported event types", () => {
      expect(parseGitHubWebhookEvent("{}", "push")).toBeNull()
      expect(parseGitHubWebhookEvent("{}", "issues")).toBeNull()
      expect(parseGitHubWebhookEvent("{}", "")).toBeNull()
    })

    test("returns null for invalid JSON", () => {
      expect(parseGitHubWebhookEvent("not json", "pull_request")).toBeNull()
    })
  })
})

// ── SyncService ─────────────────────────────────────────────────────

describe("SyncService", () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("returns 501 when github webhook secret is not configured", async () => {
    const config = makeConfig({ integrations: {} })
    const service = new SyncService(config)
    const result = await service.handleGitHubWebhook("{}", "", "pull_request")
    expect(result.status).toBe(501)
    expect(result.body).toContain("not configured")
  })

  test("returns 403 for invalid signature", async () => {
    const config = makeConfig()
    const service = new SyncService(config)
    const result = await service.handleGitHubWebhook(
      makePrPayload(),
      "sha256=invalid",
      "pull_request",
    )
    expect(result.status).toBe(403)
  })

  test("returns 200 with skipped for unsupported event type", async () => {
    const config = makeConfig()
    const service = new SyncService(config)
    const payload = '{"action":"push"}'
    const signature = await computeSignature(payload, "test-webhook-secret")
    const result = await service.handleGitHubWebhook(payload, signature, "push")
    expect(result.status).toBe(200)
    expect(result.body).toContain("skipped")
  })

  test("returns 200 with skipped when no issue identifier in branch", async () => {
    const config = makeConfig()
    const service = new SyncService(config)
    const raw = JSON.parse(makePrPayload())
    raw.pull_request.head.ref = "main"
    const payload = JSON.stringify(raw)
    const signature = await computeSignature(payload, "test-webhook-secret")
    const result = await service.handleGitHubWebhook(payload, signature, "pull_request")
    expect(result.status).toBe(200)
    expect(result.body).toContain("no issue identifier")
  })

  test("processes pr_merged event and calls Linear API", async () => {
    const config = makeConfig()
    const service = new SyncService(config)

    const fetchCalls: { url: string; body?: string }[] = []
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      fetchCalls.push({ url, body: init?.body as string })
      // Respond with success for all Linear API calls
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              team: {
                issues: {
                  nodes: [{
                    id: "issue-uuid",
                    identifier: "FIR-4",
                    title: "Import data",
                    description: "",
                    url: "https://linear.app/team/FIR-4",
                    state: { id: "state-in-progress", name: "In Progress", type: "started" },
                    team: { id: "team-uuid", key: "FIR" },
                  }],
                },
              },
              commentCreate: { success: true },
              issueUpdate: { success: true },
            },
          }),
          { status: 200 },
        ),
      )
    }) as any

    const payload = makePrPayload()
    const signature = await computeSignature(payload, "test-webhook-secret")
    const result = await service.handleGitHubWebhook(payload, signature, "pull_request")

    expect(result.status).toBe(200)
    expect(result.body).toBe('{"ok":true}')
    // Should have called Linear API: 1x fetchIssueByIdentifier + 1x addComment + 1x updateState
    expect(fetchCalls.length).toBe(3)
    // All calls go to Linear GraphQL endpoint
    expect(fetchCalls.every((c) => c.url === "https://api.linear.app/graphql")).toBe(true)
  })

  test("processes pr_opened event and posts comment", async () => {
    const config = makeConfig()
    const service = new SyncService(config)

    const fetchCalls: string[] = []
    globalThis.fetch = mock(() => {
      fetchCalls.push("called")
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              team: {
                issues: {
                  nodes: [{
                    id: "issue-uuid",
                    identifier: "FIR-4",
                    title: "Import data",
                    description: "",
                    url: "https://linear.app/team/FIR-4",
                    state: { id: "state-todo", name: "Todo", type: "unstarted" },
                    team: { id: "team-uuid", key: "FIR" },
                  }],
                },
              },
              commentCreate: { success: true },
            },
          }),
          { status: 200 },
        ),
      )
    }) as any

    const raw = JSON.parse(makePrPayload({ action: "opened" }))
    raw.pull_request.merged = false
    const payload = JSON.stringify(raw)
    const signature = await computeSignature(payload, "test-webhook-secret")
    const result = await service.handleGitHubWebhook(payload, signature, "pull_request")

    expect(result.status).toBe(200)
    // Should have called: 1x fetchIssueByIdentifier + 1x addComment (no state transition for opened)
    expect(fetchCalls.length).toBe(2)
  })

  test("handles Linear API failure gracefully", async () => {
    const config = makeConfig()
    const service = new SyncService(config)

    globalThis.fetch = mock(() => {
      return Promise.reject(new Error("network error"))
    }) as any

    const payload = makePrPayload()
    const signature = await computeSignature(payload, "test-webhook-secret")
    // Should not throw — errors are caught and logged
    const result = await service.handleGitHubWebhook(payload, signature, "pull_request")
    expect(result.status).toBe(200)
  })

  test("handles no matching Linear issue gracefully", async () => {
    const config = makeConfig()
    const service = new SyncService(config)

    globalThis.fetch = mock(() => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              team: {
                issues: { nodes: [] },
              },
            },
          }),
          { status: 200 },
        ),
      )
    }) as any

    const payload = makePrPayload()
    const signature = await computeSignature(payload, "test-webhook-secret")
    const result = await service.handleGitHubWebhook(payload, signature, "pull_request")
    expect(result.status).toBe(200)
  })
})
