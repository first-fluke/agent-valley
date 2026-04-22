/**
 * GitHub adapter — IssueTracker contract suite gate (M1b merge condition).
 *
 * The contract asserts against the issue `id` field, which for GitHub is a
 * numeric string (the issue number). The contract's synthetic ids ("a",
 * "b", "x") are strings of arbitrary shape, so this harness wraps the
 * real `GithubTrackerAdapter` with a translating proxy that:
 *
 *   - stores a string -> numeric id map (deterministic, monotonic),
 *   - rewrites inputs before delegating to the adapter,
 *   - restores the original string ids on the way out.
 *
 * The adapter itself still issues real REST calls against an injected
 * fetch — so pagination, PATCH body shape, and error mapping are all
 * covered by the contract.
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 4.6.
 */

import type { Issue } from "../../domain/models"
import type { IssueTracker } from "../../domain/ports/tracker"
import { type GithubStateLabels, GithubTrackerAdapter } from "../../tracker/adapters/github-adapter"
import { runIssueTrackerContract } from "../contracts/issue-tracker.contract"

// Align the adapter's state labels with the contract's opaque state ids so
// `updateIssueState(id, "state-ip")` flows through the label-based state
// machine without a custom translation layer.
const LABELS: GithubStateLabels = {
  todo: "state-todo",
  inProgress: "state-ip",
  done: "state-done",
  cancelled: "state-cancelled",
}

interface StoredIssue {
  number: number
  title: string
  body: string
  state: "open" | "closed"
  /** Logical state label — matches one of LABELS.{todo|inProgress|done|cancelled}. */
  stateLabel: string
  /** User-visible labels — never shadowed by stateLabel. */
  labels: Set<string>
}

function makeGithubBackend() {
  const issues = new Map<number, StoredIssue>()

  // The API presents the union (state label + user labels) so that the
  // adapter's `apiIssueToDomain` maps `issue.status` correctly. The
  // separation matters only internally for filtering on queries.
  function toApi(issue: StoredIssue) {
    const union = new Set(issue.labels)
    if (issue.stateLabel) union.add(issue.stateLabel)
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: [...union].map((name) => ({ name })),
      html_url: `https://github.com/test/test/issues/${issue.number}`,
    }
  }

  /**
   * Strip the state label when the adapter asks for labels (GET /issues/{n}
   * is used by both fetchIssueLabels and updateIssueState's read-modify-
   * write cycle; the latter re-adds the state label from the PATCH body).
   */
  function toLabelsOnlyApi(issue: StoredIssue) {
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: [...issue.labels].map((name) => ({ name })),
      html_url: `https://github.com/test/test/issues/${issue.number}`,
    }
  }

  const fakeFetch = (async (input: string | URL | { url: string }, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? "GET"
    const body = init?.body ? JSON.parse(init.body as string) : undefined

    // GET /repos/x/y/issues?labels=<label>&state=<open|closed>&per_page=&page=
    const listMatch = url.match(/\/issues\?labels=([^&]+)&state=(open|closed)&per_page=\d+&page=(\d+)/)
    if (method === "GET" && listMatch) {
      const label = decodeURIComponent(listMatch[1] ?? "")
      const state = listMatch[2] as "open" | "closed"
      const page = Number(listMatch[3])
      if (page > 1) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
      const result = [...issues.values()].filter((i) => i.stateLabel === label && i.state === state).map(toApi)
      return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } })
    }

    // GET /issues/{number} — returns labels WITHOUT the synthetic state
    // label (fetchIssueLabels contract: user labels only).
    const getMatch = url.match(/\/issues\/(\d+)$/)
    if (method === "GET" && getMatch) {
      const n = Number(getMatch[1])
      const issue = issues.get(n)
      if (!issue) return new Response("not found", { status: 404 })
      return new Response(JSON.stringify(toLabelsOnlyApi(issue)), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }

    // PATCH /issues/{number}
    const patchMatch = url.match(/\/issues\/(\d+)$/)
    if (method === "PATCH" && patchMatch) {
      const n = Number(patchMatch[1])
      const issue = issues.get(n)
      if (!issue) return new Response("not found", { status: 404 })
      if (Array.isArray(body?.labels)) {
        // Any configured state label in the new set takes over stateLabel;
        // remaining labels land in the user-visible set.
        const configured = new Set<string>([LABELS.todo, LABELS.inProgress, LABELS.done, LABELS.cancelled])
        const userLabels = new Set<string>()
        let newStateLabel = ""
        for (const l of body.labels as string[]) {
          if (configured.has(l)) newStateLabel = l
          else userLabels.add(l)
        }
        issue.labels = userLabels
        issue.stateLabel = newStateLabel
      }
      if (body?.state === "open" || body?.state === "closed") issue.state = body.state
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    }

    // POST /issues/{number}/comments
    const commentMatch = url.match(/\/issues\/(\d+)\/comments$/)
    if (method === "POST" && commentMatch) {
      const n = Number(commentMatch[1])
      const issue = issues.get(n)
      if (!issue) return new Response("not found", { status: 404 })
      // Contract only asserts no throw; ignore body.
      return new Response("{}", { status: 201, headers: { "content-type": "application/json" } })
    }

    // POST /issues/{number}/labels
    const labelMatch = url.match(/\/issues\/(\d+)\/labels$/)
    if (method === "POST" && labelMatch) {
      const n = Number(labelMatch[1])
      const issue = issues.get(n)
      if (!issue) return new Response("not found", { status: 404 })
      const incoming = body?.labels as string[] | undefined
      if (Array.isArray(incoming)) for (const l of incoming) issue.labels.add(l)
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
    }

    return new Response(`no route: ${method} ${url}`, { status: 500 })
  }) as unknown as typeof fetch

  return {
    fetch: fakeFetch,
    put(issue: StoredIssue): void {
      issues.set(issue.number, issue)
    },
  }
}

/**
 * Bidirectional string <-> numeric id translator. The contract hands us
 * arbitrary string ids ("a", "x", "does-not-exist"); the adapter speaks
 * numeric-strings. This wrapper preserves the contract's string ids on
 * the way out.
 */
class IdTranslatingTracker implements IssueTracker {
  private readonly stringToNumeric = new Map<string, number>()
  private readonly numericToString = new Map<string, string>()
  private nextNumber = 1

  constructor(
    private readonly inner: IssueTracker,
    private readonly backend: { put: (issue: StoredIssue) => void },
  ) {}

  registerSeed(domainIssue: Issue): number {
    const existing = this.stringToNumeric.get(domainIssue.id)
    const number = existing ?? this.nextNumber++
    if (!existing) {
      this.stringToNumeric.set(domainIssue.id, number)
      this.numericToString.set(String(number), domainIssue.id)
    }
    const isClosed = domainIssue.status.id === LABELS.done || domainIssue.status.id === LABELS.cancelled
    this.backend.put({
      number,
      title: domainIssue.title,
      body: domainIssue.description,
      state: isClosed ? "closed" : "open",
      stateLabel: domainIssue.status.id ?? "",
      labels: new Set<string>(domainIssue.labels ?? []),
    })
    return number
  }

  private toInner(stringId: string): string {
    const n = this.stringToNumeric.get(stringId)
    // If unknown, pass through a high numeric id that won't collide; the
    // adapter will 404 and we translate that back into the contract's
    // expected "empty labels" / "no match" outcomes.
    return n !== undefined ? String(n) : "999999"
  }

  private fromInner(numericId: string): string {
    return this.numericToString.get(numericId) ?? numericId
  }

  async fetchIssuesByState(stateIds: string[]): Promise<Issue[]> {
    const issues = await this.inner.fetchIssuesByState(stateIds)
    return issues.map((i) => ({ ...i, id: this.fromInner(i.id) }))
  }

  fetchIssueLabels(issueId: string): Promise<string[]> {
    return this.inner.fetchIssueLabels(this.toInner(issueId))
  }

  updateIssueState(issueId: string, stateId: string): Promise<void> {
    return this.inner.updateIssueState(this.toInner(issueId), stateId)
  }

  addIssueComment(issueId: string, body: string): Promise<void> {
    return this.inner.addIssueComment(this.toInner(issueId), body)
  }

  addIssueLabel(issueId: string, labelName: string): Promise<void> {
    return this.inner.addIssueLabel(this.toInner(issueId), labelName)
  }
}

runIssueTrackerContract("github", async () => {
  const backend = makeGithubBackend()
  const inner = new GithubTrackerAdapter({
    token: "test-token",
    owner: "test",
    repo: "test",
    labels: LABELS,
    timeoutMs: 5_000,
    fetch: backend.fetch,
  })
  const translator = new IdTranslatingTracker(inner, backend)

  return {
    tracker: translator,
    seedIssue: async (issue) => {
      translator.registerSeed(issue)
      return issue.id
    },
  }
})
