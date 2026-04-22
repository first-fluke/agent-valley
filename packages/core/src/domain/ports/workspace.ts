/**
 * Workspace Ports — Domain-layer interface for per-issue workspace
 * lifecycle (git worktree create/cleanup/deliver). Implemented by
 * Infrastructure adapters (filesystem + git + gh CLI).
 *
 * Design: docs/plans/domain-ports-di-seam-design.md (PR1)
 *         docs/plans/v0-2-bigbang-design.md § 4.3
 *
 * PR1 note: the signatures below mirror the current `WorkspaceManager`
 * surface losslessly. The cleaner 9-method shape from design doc § 4.3
 * (`deliver` / `mergeToMain` / `hasChanges` / `commitUncommitted`) is
 * deferred to PR2, where the internal implementation is split while
 * `FileSystemWorkspaceGateway` keeps the same facade.
 *
 * No imports from outside `domain/`. Validated by scripts/harness/validate.sh.
 */

import type { Issue, RunAttempt, Workspace } from "../models"

/** Result shape returned by long-running workspace operations. */
export interface WorkspaceOpResult {
  ok: boolean
  error?: string
  /** True when a regeneratable-lockfile retry should be scheduled. */
  retryable?: boolean
  /** Additional instructions the retrying agent should receive. */
  retryPrompt?: string
}

export interface PushResult {
  ok: boolean
  error?: string
}

export interface DraftPrResult {
  created: boolean
  url?: string
}

export interface UnfinishedWork {
  hasUncommittedChanges: boolean
  hasCodeChanges: boolean
}

/**
 * WorkspaceGateway — orchestrates a per-issue git worktree, captures agent
 * attempt metadata, and delivers finished work via merge-to-main or PR.
 */
export interface WorkspaceGateway {
  /** Create (or reuse) a worktree for `issue` under `rootOverride ?? default root`. */
  create(issue: Issue, rootOverride?: string): Promise<Workspace>

  /** Locate an existing workspace by issue id, scanning `rootOverride ?? default root`. */
  get(issueId: string, rootOverride?: string): Promise<Workspace | null>

  /** Persist a run attempt record inside the workspace metadata directory. */
  saveAttempt(workspace: Workspace, attempt: RunAttempt): Promise<void>

  /** Remove the worktree and its directory. Must be idempotent. */
  cleanup(workspace: Workspace): Promise<void>

  /** Return booleans describing uncommitted work and any diff-from-main. */
  detectUnfinishedWork(workspace: Workspace): Promise<UnfinishedWork>

  /** Safety-net auto-commit of leftover uncommitted agent work. */
  autoCommit(workspace: Workspace): Promise<WorkspaceOpResult>

  /** Human-readable diff shortstat against main, e.g. `"3 files changed, 45 insertions(+)"`. */
  getDiffStat(workspace: Workspace): Promise<string | null>

  /** Rebase the feature branch onto main and fast-forward main to it, pushing origin. */
  mergeAndPush(workspace: Workspace): Promise<WorkspaceOpResult>

  /** Push the feature branch to origin (PR mode). */
  pushBranch(workspace: Workspace): Promise<PushResult>

  /** Create a draft PR via the tracker CLI if one does not yet exist for this branch. */
  createDraftPR(workspace: Workspace, opts: { title: string; body: string }): Promise<DraftPrResult>
}
