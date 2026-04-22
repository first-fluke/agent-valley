/**
 * GithubTrackerAdapter tests — exercise every port method via a
 * module-local fetch fake. No real network is touched.
 */

import { beforeEach, describe, expect, test } from "vitest"
import { type GithubStateLabels, GithubTrackerAdapter } from "../tracker/adapters/github-adapter"

// ── fetch harness ────────────────────────────────────────────────────

interface Request {
  method: string
  url: string
  body?: unknown
  headers: Record<string, string>
}

interface Response {
  status: number
  statusText?: string
  body: unknown
  headers?: Record<string, string>
}

type Route = (req: Request) => Response | Promise<Response>

function makeFetch(routes: Route[]): { fetch: typeof fetch; requests: Request[] } {
  const requests: Request[] = []
  const fakeFetch = (async (input: string | URL | { url: string }, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? "GET"
    const headers: Record<string, string> = {}
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) headers[k.toLowerCase()] = v
    }
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    const req: Request = { method, url, body, headers }
    requests.push(req)

    for (const route of routes) {
      const out = await route(req)
      if (out) {
        const text = out.body == null ? "" : typeof out.body === "string" ? out.body : JSON.stringify(out.body)
        return new globalThis.Response(text, {
          status: out.status,
          statusText: out.statusText ?? "",
          headers: { "content-type": "application/json", ...(out.headers ?? {}) },
        })
      }
    }
    throw new Error(`No route matched: ${method} ${url}`)
  }) as unknown as typeof fetch
  return { fetch: fakeFetch, requests }
}

const LABELS: GithubStateLabels = {
  todo: "valley:todo",
  inProgress: "valley:wip",
  done: "valley:done",
  cancelled: "valley:cancelled",
}

function makeAdapter(overrides: { fetch?: typeof fetch } = {}): GithubTrackerAdapter {
  return new GithubTrackerAdapter({
    token: "ghp_test",
    owner: "first-fluke",
    repo: "agent-valley",
    labels: LABELS,
    timeoutMs: 5_000,
    fetch: overrides.fetch,
  })
}

// ── Constructor guards ───────────────────────────────────────────────

describe("GithubTrackerAdapter — constructor", () => {
  test("throws when token is missing", () => {
    expect(
      () =>
        new GithubTrackerAdapter({
          token: "",
          owner: "o",
          repo: "r",
          labels: LABELS,
        }),
    ).toThrow(/token is required/)
  })

  test("throws when owner is missing", () => {
    expect(
      () =>
        new GithubTrackerAdapter({
          token: "t",
          owner: "",
          repo: "r",
          labels: LABELS,
        }),
    ).toThrow(/owner is required/)
  })

  test("throws when repo is missing", () => {
    expect(() => new GithubTrackerAdapter({ token: "t", owner: "o", repo: "", labels: LABELS })).toThrow(
      /repo is required/,
    )
  })

  test("throws when any label is missing", () => {
    expect(
      () =>
        new GithubTrackerAdapter({
          token: "t",
          owner: "o",
          repo: "r",
          labels: { ...LABELS, todo: "" },
        }),
    ).toThrow(/labels\./)
  })
})

// ── fetchIssuesByState ───────────────────────────────────────────────

describe("GithubTrackerAdapter — fetchIssuesByState", () => {
  test("fetches one label, maps to domain Issue, excludes PRs", async () => {
    const { fetch, requests } = makeFetch([
      (req) =>
        req.url.includes("/issues?labels=valley%3Atodo")
          ? {
              status: 200,
              body: [
                {
                  number: 1,
                  title: "real issue",
                  body: "body1",
                  state: "open",
                  labels: [{ name: "valley:todo" }],
                  html_url: "u1",
                },
                {
                  number: 2,
                  title: "a PR",
                  body: "",
                  state: "open",
                  labels: [{ name: "valley:todo" }],
                  pull_request: { url: "..." },
                  html_url: "u2",
                },
              ],
            }
          : ({ status: 500, body: "unexpected" } as Response),
    ])

    const adapter = makeAdapter({ fetch })
    const issues = await adapter.fetchIssuesByState([LABELS.todo])

    expect(issues).toHaveLength(1)
    expect(issues[0]?.id).toBe("1")
    expect(issues[0]?.identifier).toBe("first-fluke/agent-valley#1")
    expect(issues[0]?.status.id).toBe(LABELS.todo)
    expect(issues[0]?.status.type).toBe("unstarted")
    expect(issues[0]?.labels).toContain("valley:todo")

    // Auth headers present
    expect(requests[0]?.headers.authorization).toBe("Bearer ghp_test")
    expect(requests[0]?.headers["accept"]).toBe("application/vnd.github+json")
    expect(requests[0]?.headers["x-github-api-version"]).toBe("2022-11-28")
  })

  test("combines multiple labels and dedupes by issue number", async () => {
    const { fetch } = makeFetch([
      (req) => {
        if (req.url.includes("labels=valley%3Atodo")) {
          return {
            status: 200,
            body: [
              { number: 10, title: "t", body: "", state: "open", labels: [{ name: "valley:todo" }], html_url: "" },
            ],
          }
        }
        if (req.url.includes("labels=valley%3Awip")) {
          // Same issue 10 also surfaces via wip (race); plus a distinct 11.
          return {
            status: 200,
            body: [
              { number: 10, title: "t", body: "", state: "open", labels: [{ name: "valley:wip" }], html_url: "" },
              { number: 11, title: "t11", body: "", state: "open", labels: [{ name: "valley:wip" }], html_url: "" },
            ],
          }
        }
        return { status: 200, body: [] }
      },
    ])

    const adapter = makeAdapter({ fetch })
    const issues = await adapter.fetchIssuesByState([LABELS.todo, LABELS.inProgress])

    const ids = issues.map((i) => i.id).sort()
    expect(ids).toEqual(["10", "11"])
  })

  test("paginates through full pages until an empty response", async () => {
    const { fetch, requests } = makeFetch([
      (req) => {
        // Anchor to &page= so we don't accidentally match per_page=.
        const match = req.url.match(/[&?]page=(\d+)/)
        const page = match ? Number(match[1]) : 1
        if (page === 1) {
          // full page of 100 fake issues to trigger next page
          const body = Array.from({ length: 100 }, (_, i) => ({
            number: i + 1,
            title: `t${i + 1}`,
            body: "",
            state: "open" as const,
            labels: [{ name: "valley:todo" }],
            html_url: "",
          }))
          return { status: 200, body }
        }
        if (page === 2) {
          return {
            status: 200,
            body: [
              {
                number: 101,
                title: "t101",
                body: "",
                state: "open",
                labels: [{ name: "valley:todo" }],
                html_url: "",
              },
            ],
          }
        }
        return { status: 200, body: [] }
      },
    ])

    const adapter = makeAdapter({ fetch })
    const issues = await adapter.fetchIssuesByState([LABELS.todo])
    expect(issues).toHaveLength(101)
    // Page 1 + Page 2 (short page stops loop) -> 2 requests.
    expect(requests).toHaveLength(2)
  })

  test("closed-state labels query with state=closed", async () => {
    const { fetch, requests } = makeFetch([() => ({ status: 200, body: [] })])

    const adapter = makeAdapter({ fetch })
    await adapter.fetchIssuesByState([LABELS.done])

    expect(requests[0]?.url).toContain("state=closed")
  })

  test("skips empty stateIds gracefully", async () => {
    const { fetch, requests } = makeFetch([() => ({ status: 200, body: [] })])
    const adapter = makeAdapter({ fetch })
    const out = await adapter.fetchIssuesByState(["", LABELS.todo])
    expect(out).toEqual([])
    expect(requests).toHaveLength(1)
  })
})

// ── updateIssueState ─────────────────────────────────────────────────

describe("GithubTrackerAdapter — updateIssueState", () => {
  test("swaps state labels while preserving non-state labels, sets state=open for todo", async () => {
    const { fetch, requests } = makeFetch([
      (req) => {
        if (req.method === "GET" && req.url.endsWith("/issues/7")) {
          return {
            status: 200,
            body: {
              number: 7,
              title: "x",
              body: "",
              state: "open",
              labels: [{ name: "scope:backend" }, { name: "valley:wip" }],
              html_url: "",
            },
          }
        }
        if (req.method === "PATCH" && req.url.endsWith("/issues/7")) {
          return { status: 200, body: {} }
        }
        return { status: 500, body: "unexpected" } as Response
      },
    ])

    const adapter = makeAdapter({ fetch })
    await adapter.updateIssueState("7", LABELS.todo)

    const patch = requests.find((r) => r.method === "PATCH")
    expect(patch).toBeDefined()
    expect(patch!.body).toMatchObject({
      labels: expect.arrayContaining(["scope:backend", LABELS.todo]),
      state: "open",
    })
    const labels = (patch!.body as { labels: string[] }).labels
    expect(labels).not.toContain(LABELS.inProgress)
  })

  test("sets state=closed with state_reason=completed for done", async () => {
    const { fetch, requests } = makeFetch([
      (req) => {
        if (req.method === "GET") {
          return {
            status: 200,
            body: { number: 9, title: "x", body: "", state: "open", labels: [{ name: "valley:wip" }], html_url: "" },
          }
        }
        return { status: 200, body: {} }
      },
    ])

    const adapter = makeAdapter({ fetch })
    await adapter.updateIssueState("9", LABELS.done)

    const patch = requests.find((r) => r.method === "PATCH")
    expect(patch!.body).toMatchObject({
      state: "closed",
      state_reason: "completed",
    })
  })

  test("sets state=closed with state_reason=not_planned for cancelled", async () => {
    const { fetch, requests } = makeFetch([
      (req) => {
        if (req.method === "GET")
          return {
            status: 200,
            body: { number: 3, title: "x", body: "", state: "open", labels: [], html_url: "" },
          }
        return { status: 200, body: {} }
      },
    ])

    const adapter = makeAdapter({ fetch })
    await adapter.updateIssueState("3", LABELS.cancelled)

    const patch = requests.find((r) => r.method === "PATCH")
    expect(patch!.body).toMatchObject({ state: "closed", state_reason: "not_planned" })
  })

  test("throws when stateId is not one of the configured labels", async () => {
    const { fetch } = makeFetch([() => ({ status: 200, body: { number: 1, labels: [] } })])
    const adapter = makeAdapter({ fetch })
    await expect(adapter.updateIssueState("1", "random:label")).rejects.toThrow(/unknown_state_label/)
  })
})

// ── addIssueComment / addIssueLabel ──────────────────────────────────

describe("GithubTrackerAdapter — comments and labels", () => {
  test("addIssueComment posts body JSON", async () => {
    const { fetch, requests } = makeFetch([(_r) => ({ status: 201, body: { id: 1 } })])
    const adapter = makeAdapter({ fetch })

    await adapter.addIssueComment("42", "hello world")

    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe("POST")
    expect(requests[0]?.url).toMatch(/\/issues\/42\/comments$/)
    expect(requests[0]?.body).toEqual({ body: "hello world" })
  })

  test("addIssueComment surfaces 429 as retryable rate-limit error", async () => {
    const { fetch } = makeFetch([
      () => ({
        status: 429,
        body: "rate limit",
        headers: { "Retry-After": "30" },
      }),
    ])
    const adapter = makeAdapter({ fetch })
    await expect(adapter.addIssueComment("1", "hi")).rejects.toThrow(/rate limit hit/i)
  })

  test("addIssueLabel POSTs the label name; duplicates are idempotent", async () => {
    const { fetch, requests } = makeFetch([(_r) => ({ status: 200, body: [] })])
    const adapter = makeAdapter({ fetch })

    await adapter.addIssueLabel("5", "score:7")
    await adapter.addIssueLabel("5", "score:7")

    expect(requests).toHaveLength(2)
    expect(requests[0]?.method).toBe("POST")
    expect(requests[0]?.url).toMatch(/\/issues\/5\/labels$/)
    expect(requests[0]?.body).toEqual({ labels: ["score:7"] })
  })

  test("fetchIssueLabels returns label names", async () => {
    const { fetch } = makeFetch([
      (_r) => ({
        status: 200,
        body: { number: 1, title: "x", body: "", state: "open", labels: [{ name: "alpha" }, "beta"], html_url: "" },
      }),
    ])
    const adapter = makeAdapter({ fetch })
    const labels = await adapter.fetchIssueLabels("1")
    expect([...labels].sort()).toEqual(["alpha", "beta"])
  })

  test("fetchIssueLabels returns empty for 404 (unknown issue)", async () => {
    const { fetch } = makeFetch([() => ({ status: 404, body: "not found" })])
    const adapter = makeAdapter({ fetch })
    expect(await adapter.fetchIssueLabels("9999")).toEqual([])
  })
})

// ── Error mapping ────────────────────────────────────────────────────

describe("GithubTrackerAdapter — error mapping", () => {
  test("401 -> unauthorized, retryable=false", async () => {
    const { fetch } = makeFetch([() => ({ status: 401, body: "bad token" })])
    const adapter = makeAdapter({ fetch })
    try {
      await adapter.addIssueComment("1", "x")
      throw new Error("expected throw")
    } catch (err) {
      expect((err as { code?: string }).code).toBe("github.unauthorized")
      expect((err as { retryable?: boolean }).retryable).toBe(false)
      // Token must not leak into the error payload.
      expect(JSON.stringify(err)).not.toContain("ghp_test")
    }
  })

  test("500 -> retryable=true", async () => {
    const { fetch } = makeFetch([() => ({ status: 500, body: "boom" })])
    const adapter = makeAdapter({ fetch })
    try {
      await adapter.addIssueComment("1", "x")
      throw new Error("expected throw")
    } catch (err) {
      expect((err as { retryable?: boolean }).retryable).toBe(true)
    }
  })

  test("network error -> github.network_error", async () => {
    const failing = (async () => {
      throw new Error("ECONNRESET")
    }) as unknown as typeof fetch
    const adapter = makeAdapter({ fetch: failing })
    try {
      await adapter.fetchIssueLabels("1")
      throw new Error("expected throw")
    } catch (err) {
      expect((err as { code?: string }).code).toBe("github.network_error")
      expect((err as { retryable?: boolean }).retryable).toBe(true)
    }
  })

  test("invalid issueId is rejected locally (no fetch call)", async () => {
    let calls = 0
    const fakeFetch = (async () => {
      calls += 1
      return new globalThis.Response("{}", { status: 200 })
    }) as unknown as typeof globalThis.fetch

    const adapter = makeAdapter({ fetch: fakeFetch })
    await expect(adapter.addIssueComment("not-a-number", "x")).rejects.toThrow(/invalid_issue_id/)
    expect(calls).toBe(0)
  })
})

// ── Small regression: sanity check on shared state ────────────────────

describe("GithubTrackerAdapter — default fetch wire-up", () => {
  let original: typeof fetch | undefined
  beforeEach(() => {
    original = globalThis.fetch
  })
  test("falls back to globalThis.fetch when config.fetch is omitted", async () => {
    let seen = 0
    globalThis.fetch = (async () => {
      seen += 1
      return new globalThis.Response("[]", { status: 200, headers: { "content-type": "application/json" } })
    }) as unknown as typeof fetch

    try {
      const adapter = new GithubTrackerAdapter({ token: "t", owner: "o", repo: "r", labels: LABELS, timeoutMs: 1000 })
      await adapter.fetchIssuesByState([LABELS.todo])
      expect(seen).toBe(1)
    } finally {
      if (original) globalThis.fetch = original
    }
  })
})
