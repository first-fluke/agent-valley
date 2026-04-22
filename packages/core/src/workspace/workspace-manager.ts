/**
 * Workspace Manager — public facade for git worktree creation, delivery,
 * cleanup, and lifecycle management. The implementation is split across
 * three internal modules (PR2). This shell composes them and preserves
 * the v0.1 public surface so `FileSystemWorkspaceGateway` and every
 * existing caller continue to work unchanged.
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 5.4
 */

import type { Issue, RunAttempt, Workspace } from "../domain/models"
import type { DeliveryResult, DraftPrResult, PushResult } from "./delivery-strategy"
import { createDraftPR, mergeAndPush, pushBranch } from "./delivery-strategy"
import { autoCommit, type WorkspaceValidationResult } from "./safety-net"
import {
  cleanupWorkspace,
  createWorkspace,
  deriveBranchName as deriveBranchNameImpl,
  deriveKey as deriveKeyImpl,
  detectUnfinishedWork,
  getDiffStat,
  getWorkspace,
  saveAttempt,
} from "./worktree-lifecycle"

/**
 * Derive a git branch name from issue identifier + title.
 * Re-exported from `worktree-lifecycle` for back-compat with callers like
 * `branch-naming.test.ts` that import directly from this module.
 */
export function deriveBranchName(identifier: string, title: string): string {
  return deriveBranchNameImpl(identifier, title)
}

export class WorkspaceManager {
  constructor(private rootPath: string) {}

  deriveKey(identifier: string): string {
    return deriveKeyImpl(identifier)
  }

  create(issue: Issue, rootOverride?: string): Promise<Workspace> {
    return createWorkspace(rootOverride ?? this.rootPath, issue)
  }

  get(issueId: string, rootOverride?: string): Promise<Workspace | null> {
    return getWorkspace(rootOverride ?? this.rootPath, issueId)
  }

  saveAttempt(workspace: Workspace, attempt: RunAttempt): Promise<void> {
    return saveAttempt(workspace, attempt)
  }

  detectUnfinishedWork(workspace: Workspace): Promise<{ hasUncommittedChanges: boolean; hasCodeChanges: boolean }> {
    return detectUnfinishedWork(workspace)
  }

  autoCommit(workspace: Workspace): Promise<WorkspaceValidationResult> {
    return autoCommit(workspace)
  }

  getDiffStat(workspace: Workspace): Promise<string | null> {
    return getDiffStat(workspace)
  }

  mergeAndPush(workspace: Workspace): Promise<DeliveryResult> {
    return mergeAndPush(workspace, this.rootPath)
  }

  pushBranch(workspace: Workspace): Promise<PushResult> {
    return pushBranch(workspace, this.rootPath)
  }

  createDraftPR(workspace: Workspace, opts: { title: string; body: string }): Promise<DraftPrResult> {
    return createDraftPR(workspace, this.rootPath, opts)
  }

  cleanup(workspace: Workspace): Promise<void> {
    return cleanupWorkspace(workspace, this.rootPath)
  }
}
