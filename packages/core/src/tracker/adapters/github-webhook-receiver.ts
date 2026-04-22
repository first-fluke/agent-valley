/**
 * GithubWebhookReceiver — Infrastructure adapter implementing the domain
 * `WebhookReceiver<ParsedWebhookEvent>` port against GitHub's `issues`
 * webhook contract.
 *
 * Signing: HMAC-SHA256 with header `X-Hub-Signature-256: sha256=<hex>`.
 * Event mapping: see § 5.2 of docs/plans/v0-2-bigbang-design.md.
 *
 * Prompt-injection defense: GitHub issue body is treated as untrusted.
 * The receiver applies a minimal boundary sanitize (strip control chars
 * and prompt boundary markers) before handing the Issue downstream. The
 * comprehensive sanitize lives at prompt-render time via
 * `config/workflow-loader.ts::sanitizeIssueBody`.
 */

import type { Issue } from "../../domain/models"
import { parseScoreFromLabels } from "../../domain/models"
import type { ParsedWebhookEvent } from "../../domain/parsed-webhook-event"
import type { IssueStateType, WebhookReceiver } from "../../domain/ports/tracker"
import type { GithubStateLabels } from "./github-adapter"

export interface GithubWebhookReceiverConfig {
  /** Webhook signing secret from GitHub (matches repository webhook settings). */
  secret: string
  /** State label table — used to translate labels to logical states. */
  labels: GithubStateLabels
}

interface GithubIssuePayload {
  number: number
  title?: string
  body?: string | null
  html_url?: string
  state?: "open" | "closed"
  labels?: Array<{ name: string } | string>
  repository_url?: string
}

interface GithubWebhookPayload {
  action?: string
  issue?: GithubIssuePayload
  label?: { name: string }
  repository?: { owner?: { login?: string }; name?: string; full_name?: string }
  changes?: Record<string, unknown>
  zen?: string
}

export class GithubWebhookReceiver implements WebhookReceiver<ParsedWebhookEvent> {
  private readonly secret: string
  private readonly labels: GithubStateLabels

  constructor(config: GithubWebhookReceiverConfig) {
    if (!config.secret) {
      throw new Error(
        "GithubWebhookReceiver: secret is required.\n" +
          "  Fix: set github.webhook_secret in valley.yaml or export the referenced env var.",
      )
    }
    if (!config.labels?.todo || !config.labels?.inProgress || !config.labels?.done || !config.labels?.cancelled) {
      throw new Error(
        "GithubWebhookReceiver: labels.{todo,inProgress,done,cancelled} are all required.\n" +
          "  Fix: add github.labels.* entries in valley.yaml.",
      )
    }
    this.secret = config.secret
    this.labels = config.labels
  }

  async verifySignature(payload: string, signature: string): Promise<boolean> {
    // Accept `sha256=<hex>` (GitHub canonical) or the bare hex for tooling parity.
    const provided = signature.startsWith("sha256=") ? signature.slice("sha256=".length) : signature
    if (!provided) return false

    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(this.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload))
    const expected = Buffer.from(sig).toString("hex")

    if (expected.length !== provided.length) return false
    let diff = 0
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i)
    }
    return diff === 0
  }

  parseEvent(payload: string): ParsedWebhookEvent | null {
    let raw: GithubWebhookPayload
    try {
      raw = JSON.parse(payload) as GithubWebhookPayload
    } catch {
      return null
    }

    // ping / non-issue / missing action -> ignore.
    if (raw.zen && !raw.action) return null
    if (!raw.action) return null

    const apiIssue = raw.issue
    // Not an issues event (e.g. pull_request, push) -> ignore.
    if (!apiIssue || typeof apiIssue.number !== "number") return null

    const issueId = String(apiIssue.number)
    const action = raw.action

    if (action === "deleted") {
      return { kind: "issue.deleted", issueId }
    }

    const issue = this.toDomainIssue(apiIssue, raw.repository)

    if (action === "edited") {
      const changedFields = Object.keys(raw.changes ?? {})
      return { kind: "issue.updated", issueId, changedFields, issue }
    }

    if (action === "closed") {
      return {
        kind: "issue.transitioned",
        issueId,
        from: null,
        to: "done",
        issue,
      }
    }

    if (action === "reopened") {
      return {
        kind: "issue.transitioned",
        issueId,
        from: null,
        to: "todo",
        issue,
      }
    }

    if (action === "opened") {
      const toFromLabels = this.issueLabelsToState(issue.labels)
      if (toFromLabels) {
        return { kind: "issue.transitioned", issueId, from: null, to: toFromLabels, issue }
      }
      return { kind: "issue.updated", issueId, changedFields: ["opened"], issue }
    }

    if (action === "labeled" || action === "unlabeled") {
      const changed = raw.label?.name
      if (!changed) return null
      const mapped = this.labelNameToState(changed)
      // state label added -> transitioned; other cases -> labeled.
      if (mapped && action === "labeled") {
        return { kind: "issue.transitioned", issueId, from: null, to: mapped, issue }
      }
      return { kind: "issue.labeled", issueId, label: changed, issue }
    }

    // assigned, unassigned, milestoned, transferred, etc. -> surface as
    // updated so the orchestrator can choose to ignore. Never throw on
    // unknown actions.
    return { kind: "issue.updated", issueId, changedFields: [action], issue }
  }

  // ── Mappers ─────────────────────────────────────────────────────────

  private labelNameToState(name: string): IssueStateType | null {
    if (name === this.labels.todo) return "todo"
    if (name === this.labels.inProgress) return "in_progress"
    if (name === this.labels.done) return "done"
    if (name === this.labels.cancelled) return "cancelled"
    return null
  }

  private issueLabelsToState(labels: string[]): IssueStateType | null {
    if (labels.includes(this.labels.done)) return "done"
    if (labels.includes(this.labels.cancelled)) return "cancelled"
    if (labels.includes(this.labels.inProgress)) return "in_progress"
    if (labels.includes(this.labels.todo)) return "todo"
    return null
  }

  private toDomainIssue(api: GithubIssuePayload, repo?: { owner?: { login?: string }; name?: string }): Issue {
    const labelNames = (api.labels ?? [])
      .map((l) => (typeof l === "string" ? l : l.name))
      .filter((n): n is string => typeof n === "string")
    const owner = repo?.owner?.login ?? "unknown"
    const name = repo?.name ?? "unknown"
    const teamKey = owner
    const teamId = `${owner}/${name}`

    const description = sanitizeAtBoundary(api.body ?? "")

    // Synthetic status reducer — duplicated with GithubTrackerAdapter so
    // that neither depends on the other's internals.
    const status = statusFromLabels(labelNames, api.state ?? "open", this.labels)

    return {
      id: String(api.number),
      identifier: `${owner}/${name}#${api.number}`,
      title: api.title ?? "",
      description,
      status,
      team: { id: teamId, key: teamKey },
      labels: labelNames,
      url: api.html_url ?? "",
      score: parseScoreFromLabels(labelNames),
      parentId: null,
      children: [],
      relations: [],
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function statusFromLabels(
  labels: string[],
  ghState: "open" | "closed",
  stateLabels: GithubStateLabels,
): { id: string; name: string; type: string } {
  if (labels.includes(stateLabels.done)) return { id: stateLabels.done, name: "Done", type: "completed" }
  if (labels.includes(stateLabels.cancelled)) return { id: stateLabels.cancelled, name: "Cancelled", type: "canceled" }
  if (labels.includes(stateLabels.inProgress))
    return { id: stateLabels.inProgress, name: "In Progress", type: "started" }
  if (labels.includes(stateLabels.todo)) return { id: stateLabels.todo, name: "Todo", type: "unstarted" }
  const fallbackId = ghState === "closed" ? "github:closed:untagged" : "github:open:untagged"
  return { id: fallbackId, name: ghState === "closed" ? "Closed" : "Open", type: ghState }
}

const MAX_BOUNDARY_BODY_LENGTH = 64_000
const PROMPT_BOUNDARY_MARKERS = [
  /<\s*\|\s*im_start\s*\|\s*>/gi,
  /<\s*\|\s*im_end\s*\|\s*>/gi,
  /<\s*\|\s*system\s*\|\s*>/gi,
]

/**
 * Boundary-level sanitizer: strip control characters that could break
 * downstream JSON parsing / logs, chop absurdly long bodies, and remove
 * prompt-boundary markers. Deeper injection handling is left to
 * `config/workflow-loader.ts::sanitizeIssueBody` at render time.
 */
function sanitizeAtBoundary(text: string): string {
  if (!text) return ""
  // Keep \n (\x0A), \r (\x0D), \t (\x09); strip other C0 + DEL.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the intent
  let out = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
  if (out.length > MAX_BOUNDARY_BODY_LENGTH) out = out.slice(0, MAX_BOUNDARY_BODY_LENGTH)
  for (const pattern of PROMPT_BOUNDARY_MARKERS) out = out.replace(pattern, "")
  return out
}
