/**
 * GhCliCodeHost — Infrastructure adapter implementing the domain
 * `CodeHost` port with the `gh` CLI. PR delivery already depends on an
 * authenticated `gh` (`workspace/delivery-strategy.ts::createDraftPR`), so
 * review follow-up reuses that login instead of another GitHub token.
 */

import type { CodeHost, PullRequestReviewComment } from "../../domain/ports/code-host"
import { type CommandResult, runCommand } from "../worktree-lifecycle"

type CommandRunner = (cmd: string, args: string[]) => Promise<CommandResult>

interface GithubReviewCommentApi {
  path?: string
  line?: number | null
  original_line?: number | null
  body?: string | null
}

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export class GhCliCodeHost implements CodeHost {
  constructor(private readonly run: CommandRunner = (cmd, args) => runCommand(cmd, args)) {}

  async fetchPullRequestReviewComments(
    repository: string,
    pullNumber: number,
    reviewId: string,
  ): Promise<PullRequestReviewComment[]> {
    if (!REPOSITORY_PATTERN.test(repository) || !Number.isInteger(pullNumber) || !/^\d+$/.test(reviewId)) {
      throw new Error(`Invalid pull request review reference: ${repository}#${pullNumber} review ${reviewId}`)
    }
    // One page covers any review a person writes; GitHub caps per_page at 100.
    const path = `repos/${repository}/pulls/${pullNumber}/reviews/${reviewId}/comments?per_page=100`
    const { exitCode, stdout, stderr } = await this.run("gh", ["api", path])
    if (exitCode !== 0) {
      throw new Error(`gh api ${path} failed: ${stderr.trim() || `exit ${exitCode}`}\n  Fix: run \`gh auth status\``)
    }
    const comments = JSON.parse(stdout.trim() || "[]") as GithubReviewCommentApi[]
    return comments.map((comment) => ({
      path: comment.path ?? "",
      line: comment.line ?? comment.original_line ?? null,
      body: comment.body ?? "",
    }))
  }
}
