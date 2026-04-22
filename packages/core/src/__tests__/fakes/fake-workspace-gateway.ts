/**
 * FakeWorkspaceGateway — in-memory WorkspaceGateway for unit and contract
 * tests. Avoids real git operations.
 */

import type { Issue, RunAttempt, Workspace } from "../../domain/models"
import type {
  DraftPrResult,
  PushResult,
  UnfinishedWork,
  WorkspaceGateway,
  WorkspaceOpResult,
} from "../../domain/ports/workspace"

export interface FakeWorkspaceGatewayOptions {
  /** Default root used when derivation is needed. */
  root?: string
  mergeResult?: WorkspaceOpResult
  autoCommitResult?: WorkspaceOpResult
  pushResult?: PushResult
  draftPrResult?: DraftPrResult
  diffStat?: string | null
  unfinished?: UnfinishedWork
}

export class FakeWorkspaceGateway implements WorkspaceGateway {
  public readonly workspaces = new Map<string, Workspace>()
  public readonly attempts: Array<{ workspace: Workspace; attempt: RunAttempt }> = []
  public readonly events: string[] = []
  public readonly changes = new Map<string, boolean>()

  public mergeResult: WorkspaceOpResult
  public autoCommitResult: WorkspaceOpResult
  public pushResult: PushResult
  public draftPrResult: DraftPrResult
  public diffStat: string | null
  public unfinished: UnfinishedWork
  public root: string

  constructor(opts: FakeWorkspaceGatewayOptions = {}) {
    this.root = opts.root ?? "/tmp/fake-workspace-root"
    this.mergeResult = opts.mergeResult ?? { ok: true }
    this.autoCommitResult = opts.autoCommitResult ?? { ok: true }
    this.pushResult = opts.pushResult ?? { ok: true }
    this.draftPrResult = opts.draftPrResult ?? { created: false }
    this.diffStat = opts.diffStat ?? null
    this.unfinished = opts.unfinished ?? { hasUncommittedChanges: false, hasCodeChanges: false }
  }

  async create(issue: Issue, rootOverride?: string): Promise<Workspace> {
    const root = rootOverride ?? this.root
    const key = issue.identifier.replace(/[^A-Za-z0-9._-]/g, "_")
    const prefix = issue.title.startsWith("fix") ? "fix" : "feature"
    const workspace: Workspace = {
      issueId: issue.id,
      path: `${root}/${key}`,
      key,
      branch: `${prefix}/${issue.identifier}`,
      status: "idle",
      createdAt: new Date().toISOString(),
    }
    this.workspaces.set(issue.id, workspace)
    this.events.push(`create:${issue.id}`)
    return workspace
  }

  async get(issueId: string): Promise<Workspace | null> {
    return this.workspaces.get(issueId) ?? null
  }

  async saveAttempt(workspace: Workspace, attempt: RunAttempt): Promise<void> {
    this.attempts.push({ workspace, attempt })
  }

  async cleanup(workspace: Workspace): Promise<void> {
    this.workspaces.delete(workspace.issueId)
    this.events.push(`cleanup:${workspace.issueId}`)
  }

  async detectUnfinishedWork(_workspace: Workspace): Promise<UnfinishedWork> {
    return this.unfinished
  }

  async autoCommit(_workspace: Workspace): Promise<WorkspaceOpResult> {
    return this.autoCommitResult
  }

  async getDiffStat(_workspace: Workspace): Promise<string | null> {
    return this.diffStat
  }

  async mergeAndPush(workspace: Workspace): Promise<WorkspaceOpResult> {
    this.events.push(`mergeAndPush:${workspace.issueId}`)
    return this.mergeResult
  }

  async pushBranch(workspace: Workspace): Promise<PushResult> {
    this.events.push(`pushBranch:${workspace.issueId}`)
    return this.pushResult
  }

  async createDraftPR(workspace: Workspace, _opts: { title: string; body: string }): Promise<DraftPrResult> {
    this.events.push(`createDraftPR:${workspace.issueId}`)
    return this.draftPrResult
  }
}
