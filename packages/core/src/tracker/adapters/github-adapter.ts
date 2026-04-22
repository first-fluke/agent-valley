/**
 * GithubTrackerAdapter — Infrastructure adapter implementing the domain
 * `IssueTracker` port against GitHub's REST v3 API.
 *
 * State model:
 *   - The `stateIds` parameters surfaced by the port are **label names**
 *     configured in `valley.yaml` (`github.labels.{todo,inProgress,...}`).
 *   - `updateIssueState` swaps state labels and closes/reopens the issue
 *     when transitioning to/from the terminal states.
 *   - Pull requests are excluded from `fetchIssuesByState`.
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 4.1 / § 5.1 (M1b).
 */

import type { Issue } from "../../domain/models"
import { parseScoreFromLabels } from "../../domain/models"
import type { IssueTracker } from "../../domain/ports/tracker"

const GITHUB_API_URL = "https://api.github.com"
const DEFAULT_TIMEOUT_MS = 30_000

export interface GithubStateLabels {
  /** Label name representing the "todo" (unstarted) logical state. */
  todo: string
  /** Label name representing the "in progress" logical state. */
  inProgress: string
  /** Label name representing the "done" (completed) logical state. */
  done: string
  /** Label name representing the "cancelled" logical state. */
  cancelled: string
}

export interface GithubTrackerAdapterConfig {
  /** GitHub token (e.g. PAT or installation token). Never logged. */
  token: string
  /** Repository owner (user or org). */
  owner: string
  /** Repository name. */
  repo: string
  /** State label names — used to translate logical states. */
  labels: GithubStateLabels
  /**
   * Optional request timeout. Defaults to 30s.
   * Kept as a config parameter so tests can shrink it.
   */
  timeoutMs?: number
  /**
   * Optional fetch override. Defaults to `globalThis.fetch`. Tests inject a
   * module-local fake; production never sets this.
   */
  fetch?: typeof fetch
}

interface GithubIssueApi {
  number: number
  title: string
  body: string | null
  state: "open" | "closed"
  html_url: string
  pull_request?: unknown
  labels: Array<{ name: string } | string>
  assignees?: Array<{ login: string }>
}

/**
 * Format a tracker error with the ValleyError 5-field convention embedded
 * in the message. We keep the existing `Error` class to stay compatible
 * with callers that inspect `.message` (e.g. RetryQueue).
 */
function trackerError(params: {
  code: string
  message: string
  context: Record<string, unknown>
  fixHint: string
  retryable: boolean
}): Error {
  // Never include the token in error context.
  const safeContext = { ...params.context }
  const err = new Error(
    `${params.message}\n` +
      `  code: ${params.code}\n` +
      `  context: ${JSON.stringify(safeContext)}\n` +
      `  fix: ${params.fixHint}\n` +
      `  retryable: ${params.retryable}`,
  )
  // Attach for programmatic consumers without exposing the token.
  Object.assign(err, {
    code: params.code,
    context: safeContext,
    fixHint: params.fixHint,
    retryable: params.retryable,
  })
  return err
}

export class GithubTrackerAdapter implements IssueTracker {
  private readonly token: string
  private readonly owner: string
  private readonly repo: string
  private readonly labels: GithubStateLabels
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(config: GithubTrackerAdapterConfig) {
    if (!config.token) {
      throw new Error(
        "GithubTrackerAdapter: token is required.\n" +
          "  Fix: set github.token_env in valley.yaml and export the referenced env var.\n" +
          "  Required scopes: issues:write, pull_requests:write, contents:write.",
      )
    }
    if (!config.owner) {
      throw new Error(
        "GithubTrackerAdapter: owner is required.\n  Fix: set github.owner in valley.yaml (e.g. 'first-fluke').",
      )
    }
    if (!config.repo) {
      throw new Error(
        "GithubTrackerAdapter: repo is required.\n  Fix: set github.repo in valley.yaml (e.g. 'agent-valley').",
      )
    }
    if (!config.labels?.todo || !config.labels?.inProgress || !config.labels?.done || !config.labels?.cancelled) {
      throw new Error(
        "GithubTrackerAdapter: labels.{todo,inProgress,done,cancelled} are all required.\n" +
          "  Fix: add github.labels.* entries in valley.yaml.",
      )
    }
    this.token = config.token
    this.owner = config.owner
    this.repo = config.repo
    this.labels = config.labels
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchImpl = config.fetch ?? globalThis.fetch
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agent-valley-orchestrator",
    }
  }

  private repoUrl(path: string): string {
    return `${GITHUB_API_URL}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${path}`
  }

  /**
   * Issue GraphQL-free REST request with consistent error mapping. Callers
   * pass `method`, `path`, and optional `body`; the method mirrors the
   * Linear adapter's shape (throws on non-2xx with actionable hints).
   */
  private async request<T>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          ...this.authHeaders(),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      const msg = (err as Error).message ?? String(err)
      throw trackerError({
        code: "github.network_error",
        message: `GitHub request failed: ${method} ${url}`,
        context: { method, url, cause: msg },
        fixHint: "Retry once network recovers; if persistent, verify DNS and proxy settings.",
        retryable: true,
      })
    }
    clearTimeout(timer)

    const text = await response.text()
    if (response.status === 401) {
      throw trackerError({
        code: "github.unauthorized",
        message: "GitHub authentication failed (401).",
        context: { method, url, status: response.status },
        fixHint: "Check the env var referenced by github.token_env; token must have issues:write scope.",
        retryable: false,
      })
    }
    if (response.status === 403) {
      throw trackerError({
        code: "github.forbidden",
        message: "GitHub request forbidden (403).",
        context: { method, url, status: response.status, body: truncate(text) },
        fixHint: "Token lacks required scopes or hit secondary rate limit. Check token scopes.",
        retryable: false,
      })
    }
    if (response.status === 404) {
      throw trackerError({
        code: "github.not_found",
        message: `GitHub resource not found (404): ${method} ${url}`,
        context: { method, url, status: response.status },
        fixHint: "Verify github.owner / github.repo in valley.yaml and that the issue exists.",
        retryable: false,
      })
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After") ?? "60"
      throw trackerError({
        code: "github.rate_limited",
        message: `GitHub rate limit hit (429). Retry after ${retryAfter}s.`,
        context: { method, url, status: response.status, retryAfter },
        fixHint: "Back off and retry after Retry-After seconds.",
        retryable: true,
      })
    }
    if (response.status < 200 || response.status >= 300) {
      throw trackerError({
        code: "github.http_error",
        message: `GitHub API error: ${response.status} ${response.statusText}`,
        context: { method, url, status: response.status, body: truncate(text) },
        fixHint: "Inspect response body; if 5xx, retry with backoff.",
        retryable: response.status >= 500,
      })
    }

    const data = text ? (JSON.parse(text) as T) : (undefined as unknown as T)
    return { status: response.status, data }
  }

  async fetchIssuesByState(stateIds: string[]): Promise<Issue[]> {
    // De-dupe by issue number across labels (an issue can carry multiple
    // state labels during a transition race).
    const byNumber = new Map<number, Issue>()

    for (const label of stateIds) {
      if (!label) continue
      const apiIssues = await this.fetchIssuesForLabel(label)
      for (const api of apiIssues) {
        if (api.pull_request) continue // skip PRs
        const issue = this.apiIssueToDomain(api)
        byNumber.set(api.number, issue)
      }
    }

    return [...byNumber.values()]
  }

  private async fetchIssuesForLabel(label: string): Promise<GithubIssueApi[]> {
    const all: GithubIssueApi[] = []
    // Decide issue state filter: closed labels fetch with state=closed so we
    // don't miss completed issues; open labels with state=open.
    const ghState = label === this.labels.done || label === this.labels.cancelled ? "closed" : "open"

    // Paginate. GitHub max is 100 per page.
    const perPage = 100
    let page = 1
    const hardCap = 50 // never loop forever — 5,000 issues is enough for a repo.
    while (page <= hardCap) {
      const url =
        this.repoUrl(`/issues`) +
        `?labels=${encodeURIComponent(label)}&state=${ghState}&per_page=${perPage}&page=${page}`
      const { data } = await this.request<GithubIssueApi[]>("GET", url)
      if (!Array.isArray(data) || data.length === 0) break
      all.push(...data)
      if (data.length < perPage) break
      page += 1
    }
    return all
  }

  async fetchIssueLabels(issueId: string): Promise<string[]> {
    const number = parseIssueNumber(issueId)
    try {
      const { data } = await this.request<GithubIssueApi>("GET", this.repoUrl(`/issues/${number}`))
      return extractLabelNames(data.labels)
    } catch (err) {
      if ((err as { code?: string }).code === "github.not_found") return []
      throw err
    }
  }

  async updateIssueState(issueId: string, stateId: string): Promise<void> {
    const number = parseIssueNumber(issueId)
    const newLabel = stateId
    const allStateLabels = new Set([this.labels.todo, this.labels.inProgress, this.labels.done, this.labels.cancelled])
    if (!allStateLabels.has(newLabel)) {
      throw trackerError({
        code: "github.unknown_state_label",
        message: `updateIssueState called with unknown state label "${newLabel}".`,
        context: { stateId: newLabel, known: [...allStateLabels] },
        fixHint: "Pass one of github.labels.{todo,in_progress,done,cancelled} values from valley.yaml.",
        retryable: false,
      })
    }

    // 1. Fetch current labels; keep all non-state labels untouched.
    const current = await this.fetchIssueLabels(issueId)
    const preserved = current.filter((l) => !allStateLabels.has(l))
    const nextLabels = [...new Set([...preserved, newLabel])]

    // 2. Decide GitHub open/closed lifecycle.
    const wantClosed = newLabel === this.labels.done || newLabel === this.labels.cancelled
    const patchBody: Record<string, unknown> = {
      labels: nextLabels,
      state: wantClosed ? "closed" : "open",
    }
    if (wantClosed) {
      patchBody.state_reason = newLabel === this.labels.cancelled ? "not_planned" : "completed"
    }

    await this.request("PATCH", this.repoUrl(`/issues/${number}`), patchBody)
  }

  async addIssueComment(issueId: string, body: string): Promise<void> {
    const number = parseIssueNumber(issueId)
    await this.request("POST", this.repoUrl(`/issues/${number}/comments`), { body })
  }

  async addIssueLabel(issueId: string, labelName: string): Promise<void> {
    const number = parseIssueNumber(issueId)
    // GitHub's POST /issues/{n}/labels is additive and idempotent on duplicates.
    await this.request("POST", this.repoUrl(`/issues/${number}/labels`), { labels: [labelName] })
  }

  // ── Mappers ─────────────────────────────────────────────────────────

  private apiIssueToDomain(api: GithubIssueApi): Issue {
    const labels = extractLabelNames(api.labels)
    const statusType = this.labelsToStatusType(labels, api.state)
    return {
      id: String(api.number),
      identifier: `${this.owner}/${this.repo}#${api.number}`,
      title: api.title,
      description: api.body ?? "",
      status: { id: statusType.id, name: statusType.name, type: statusType.type },
      team: { id: `${this.owner}/${this.repo}`, key: this.owner },
      labels,
      url: api.html_url,
      score: parseScoreFromLabels(labels),
      parentId: null,
      children: [],
      relations: [],
    }
  }

  /**
   * Reduce the issue's labels + GitHub open/closed state to the tracker's
   * synthetic status triple. `id` is set to the matching state label when
   * one of our configured state labels is present — this preserves the
   * invariant that `fetchIssuesByState(stateIds)` filters by id.
   */
  private labelsToStatusType(labels: string[], ghState: "open" | "closed"): { id: string; name: string; type: string } {
    const { todo, inProgress, done, cancelled } = this.labels
    if (labels.includes(done)) return { id: done, name: "Done", type: "completed" }
    if (labels.includes(cancelled)) return { id: cancelled, name: "Cancelled", type: "canceled" }
    if (labels.includes(inProgress)) return { id: inProgress, name: "In Progress", type: "started" }
    if (labels.includes(todo)) return { id: todo, name: "Todo", type: "unstarted" }
    // Untagged issue: still surface it but with a clearly non-state id so
    // fetchIssuesByState never matches it accidentally.
    const fallbackId = ghState === "closed" ? "github:closed:untagged" : "github:open:untagged"
    return { id: fallbackId, name: ghState === "closed" ? "Closed" : "Open", type: ghState }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function parseIssueNumber(issueId: string): number {
  const n = Number.parseInt(issueId, 10)
  if (Number.isNaN(n) || n <= 0) {
    throw trackerError({
      code: "github.invalid_issue_id",
      message: `issueId "${issueId}" is not a positive integer.`,
      context: { issueId },
      fixHint: "GitHub adapter expects issueId to be the numeric issue number (e.g. '42').",
      retryable: false,
    })
  }
  return n
}

function extractLabelNames(labels: Array<{ name: string } | string> | undefined): string[] {
  if (!labels) return []
  return labels.map((l) => (typeof l === "string" ? l : l.name)).filter((n): n is string => typeof n === "string")
}

function truncate(s: string, max = 400): string {
  return s.length > max ? `${s.slice(0, max)}...[truncated]` : s
}
