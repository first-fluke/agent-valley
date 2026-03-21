/**
 * GitHub Integration — Posts comments on GitHub PRs when agent lifecycle events occur.
 * Infrastructure layer adapter. No business logic — format and send only.
 */

import type { IntegrationEvent, IntegrationStatus } from "../domain/models"
import { logger } from "../observability/logger"
import type { Integration } from "./types"

const COMPONENT = "github-integration"

const COMMENT_TEMPLATES: Record<string, (detail: string | null) => string> = {
  agent_started: () => "🚀 Symphony agent started working on this issue",
  agent_completed: (detail) => `✅ Symphony agent completed\n\n${detail ?? ""}`,
  agent_failed: (detail) => `❌ Symphony agent failed\n\n${detail ?? ""}`,
  agent_timeout: (detail) => `⏰ Symphony agent timed out\n\n${detail ?? ""}`,
}

export class GitHubIntegration implements Integration {
  readonly type = "github"

  private readonly token: string
  private readonly owner: string
  private readonly repo: string
  private lastEventAt: string | null = null
  private lastError: string | null = null

  constructor(config: { token: string; owner: string; repo: string }) {
    this.token = config.token
    this.owner = config.owner
    this.repo = config.repo
  }

  status(): IntegrationStatus {
    return {
      type: "github",
      configured: true,
      lastEventAt: this.lastEventAt,
      error: this.lastError,
    }
  }

  async notify(event: IntegrationEvent): Promise<void> {
    try {
      const prNumber = await this.findPullRequestNumber(event.issueIdentifier)
      if (prNumber === null) {
        logger.warn(COMPONENT, "No matching PR found for issue; skipping comment", {
          issueIdentifier: event.issueIdentifier,
        })
        return
      }

      const body = this.formatComment(event)
      await this.postComment(prNumber, body)

      this.lastEventAt = event.timestamp
      this.lastError = null

      logger.info(COMPONENT, "Posted comment on GitHub PR", {
        issueIdentifier: event.issueIdentifier,
        prNumber,
        kind: event.kind,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.lastError = message
      logger.error(COMPONENT, "Failed to post GitHub comment; check GITHUB_TOKEN and repo config", {
        issueIdentifier: event.issueIdentifier,
        kind: event.kind,
        error: message,
      })
    }
  }

  private async findPullRequestNumber(issueIdentifier: string): Promise<number | null> {
    // Search open PRs whose head branch contains the issue identifier (e.g. "FIR-3")
    const branch = encodeURIComponent(`${this.owner}:${issueIdentifier.toLowerCase()}`)
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/pulls?head=${branch}&state=open&per_page=10`

    const response = await fetch(url, { headers: this.authHeaders() })

    if (!response.ok) {
      throw new Error(
        `GitHub API returned ${response.status} when searching PRs for branch containing "${issueIdentifier}". ` +
          `Verify GITHUB_TOKEN has 'repo' scope and GITHUB_OWNER/GITHUB_REPO are correct.`,
      )
    }

    const pulls = (await response.json()) as Array<{ number: number; head: { ref: string } }>

    // Find the first PR whose branch name contains the issue identifier (case-insensitive)
    const identifier = issueIdentifier.toLowerCase()
    const match = pulls.find((pr) => pr.head.ref.toLowerCase().includes(identifier))

    if (match) {
      return match.number
    }

    // Fallback: search all open PRs for a branch matching the identifier
    const allUrl = `https://api.github.com/repos/${this.owner}/${this.repo}/pulls?state=open&per_page=100`
    const allResponse = await fetch(allUrl, { headers: this.authHeaders() })

    if (!allResponse.ok) {
      throw new Error(
        `GitHub API returned ${allResponse.status} when listing open PRs. ` +
          `Verify GITHUB_TOKEN has 'repo' scope.`,
      )
    }

    const allPulls = (await allResponse.json()) as Array<{ number: number; head: { ref: string } }>
    const fallbackMatch = allPulls.find((pr) => pr.head.ref.toLowerCase().includes(identifier))

    return fallbackMatch?.number ?? null
  }

  private async postComment(prNumber: number, body: string): Promise<void> {
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/issues/${prNumber}/comments`

    const response = await fetch(url, {
      method: "POST",
      headers: { ...this.authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    })

    if (!response.ok) {
      throw new Error(
        `GitHub API returned ${response.status} when posting comment on PR #${prNumber}. ` +
          `Verify GITHUB_TOKEN has write access to ${this.owner}/${this.repo}.`,
      )
    }
  }

  private formatComment(event: IntegrationEvent): string {
    const template = COMMENT_TEMPLATES[event.kind]
    if (!template) {
      return `Symphony agent event: ${event.kind}`
    }
    return template(event.detail)
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    }
  }
}
