/**
 * FileSystemWorkspaceGateway — Infrastructure adapter implementing the
 * domain `WorkspaceGateway` port. Composes the existing `WorkspaceManager`
 * (no inheritance) so PR2's internal split can swap the composition body
 * without changing callers.
 *
 * Design: docs/plans/domain-ports-di-seam-design.md § 3.2
 */

import type { Issue, RunAttempt, Workspace } from "../../domain/models"
import type {
  DraftPrResult,
  PushResult,
  UnfinishedWork,
  WorkspaceGateway,
  WorkspaceOpResult,
} from "../../domain/ports/workspace"
import type { WorkspaceManager } from "../workspace-manager"

export class FileSystemWorkspaceGateway implements WorkspaceGateway {
  constructor(private readonly wm: WorkspaceManager) {}

  create(issue: Issue, rootOverride?: string): Promise<Workspace> {
    return this.wm.create(issue, rootOverride)
  }

  get(issueId: string, rootOverride?: string): Promise<Workspace | null> {
    return this.wm.get(issueId, rootOverride)
  }

  saveAttempt(workspace: Workspace, attempt: RunAttempt): Promise<void> {
    return this.wm.saveAttempt(workspace, attempt)
  }

  cleanup(workspace: Workspace): Promise<void> {
    return this.wm.cleanup(workspace)
  }

  detectUnfinishedWork(workspace: Workspace): Promise<UnfinishedWork> {
    return this.wm.detectUnfinishedWork(workspace)
  }

  autoCommit(workspace: Workspace): Promise<WorkspaceOpResult> {
    return this.wm.autoCommit(workspace)
  }

  getDiffStat(workspace: Workspace): Promise<string | null> {
    return this.wm.getDiffStat(workspace)
  }

  mergeAndPush(workspace: Workspace): Promise<WorkspaceOpResult> {
    return this.wm.mergeAndPush(workspace)
  }

  pushBranch(workspace: Workspace): Promise<PushResult> {
    return this.wm.pushBranch(workspace)
  }

  createDraftPR(workspace: Workspace, opts: { title: string; body: string }): Promise<DraftPrResult> {
    return this.wm.createDraftPR(workspace, opts)
  }
}
