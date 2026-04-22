import { afterEach, describe, expect, it, vi } from "vitest"
import { buildGithubLabels, randomWebhookSecret, verifyGithubToken } from "../../setup/github-api"

describe("buildGithubLabels", () => {
  it("expands the default prefix into the four label names", () => {
    expect(buildGithubLabels("valley")).toEqual({
      todo: "valley:todo",
      inProgress: "valley:wip",
      done: "valley:done",
      cancelled: "valley:cancelled",
    })
  })

  it("falls back to 'valley' when the prefix is blank", () => {
    expect(buildGithubLabels("")).toEqual({
      todo: "valley:todo",
      inProgress: "valley:wip",
      done: "valley:done",
      cancelled: "valley:cancelled",
    })
  })

  it("accepts a custom prefix", () => {
    expect(buildGithubLabels("sym").todo).toBe("sym:todo")
    expect(buildGithubLabels("sym").cancelled).toBe("sym:cancelled")
  })

  it("trims whitespace in the prefix", () => {
    expect(buildGithubLabels("  prod  ").inProgress).toBe("prod:wip")
  })
})

describe("randomWebhookSecret", () => {
  it("returns a 64-character hex string (32 random bytes)", () => {
    const s = randomWebhookSecret()
    expect(s).toMatch(/^[0-9a-f]{64}$/)
  })

  it("returns different values on repeated calls", () => {
    const a = randomWebhookSecret()
    const b = randomWebhookSecret()
    expect(a).not.toBe(b)
  })
})

describe("verifyGithubToken", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("returns ok when /user returns 200 with required scope", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ login: "octocat" }), {
          status: 200,
          headers: { "x-oauth-scopes": "repo, workflow" },
        }),
    ) as unknown as typeof fetch

    const result = await verifyGithubToken("ghp_abc123", fakeFetch)
    expect(result.ok).toBe(true)
    expect(result.login).toBe("octocat")
    expect(result.scopes).toEqual(["repo", "workflow"])
  })

  it("returns ok for fine-grained PAT (no scopes header)", async () => {
    const fakeFetch = vi.fn(
      async () => new Response(JSON.stringify({ login: "octocat" }), { status: 200 }),
    ) as unknown as typeof fetch

    const result = await verifyGithubToken("github_pat_xxx", fakeFetch)
    expect(result.ok).toBe(true)
    expect(result.scopes).toEqual([])
  })

  it("returns 5-field error on 401", async () => {
    const fakeFetch = vi.fn(async () => new Response("", { status: 401 })) as unknown as typeof fetch
    const result = await verifyGithubToken("bad", fakeFetch)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("code: setup.github.unauthorized")
    expect(result.error).toContain("fix:")
    expect(result.error).toContain("retryable: true")
  })

  it("returns 5-field error when classic PAT is missing required scope", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ login: "octocat" }), {
          status: 200,
          headers: { "x-oauth-scopes": "gist" },
        }),
    ) as unknown as typeof fetch

    const result = await verifyGithubToken("ghp_abc", fakeFetch)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("code: setup.github.missing_scope")
    expect(result.error).toContain('"scopes":["gist"]')
  })

  it("returns 5-field error on empty token without calling fetch", async () => {
    const fakeFetch = vi.fn() as unknown as typeof fetch
    const result = await verifyGithubToken("", fakeFetch)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("code: setup.github.token_missing")
    expect((fakeFetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0)
  })

  it("returns 5-field error on network error", async () => {
    const fakeFetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    const result = await verifyGithubToken("t", fakeFetch)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("code: setup.github.network_error")
    expect(result.error).toContain("ECONNREFUSED")
  })

  it("sends Authorization Bearer header", async () => {
    let captured: RequestInit | undefined
    const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      captured = init
      return new Response(JSON.stringify({ login: "o" }), { status: 200 })
    }) as unknown as typeof fetch

    await verifyGithubToken("TOKEN_VALUE", fakeFetch)
    const headers = captured?.headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer TOKEN_VALUE")
    expect(headers["User-Agent"]).toBe("agent-valley-setup")
  })
})
