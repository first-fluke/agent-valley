# Workspace Manager

> Responsibility: Creating, managing, and cleaning up per-issue isolated workspaces.
> SRP: Handles only directory and git worktree lifecycle. Agent execution is the responsibility of `agent-runner.md`.

Domain models: See `domain-models.md` (Workspace, Workspace Key derivation rules).

---

## Domain Port (v0.2+)

The Application layer talks to workspaces through `WorkspaceGateway`
(`packages/core/src/domain/ports/workspace.ts`):

```typescript
interface WorkspaceGateway {
  create(issue: Issue, rootOverride?: string): Promise<Workspace>
  get(issueId: string, rootOverride?: string): Promise<Workspace | null>
  saveAttempt(workspace: Workspace, attempt: RunAttempt): Promise<void>
  cleanup(workspace: Workspace): Promise<void>
  detectUnfinishedWork(workspace: Workspace): Promise<UnfinishedWork>
  autoCommit(workspace: Workspace): Promise<WorkspaceOpResult>
  getDiffStat(workspace: Workspace): Promise<string | null>
  mergeAndPush(workspace: Workspace): Promise<WorkspaceOpResult>
  pushBranch(workspace: Workspace): Promise<PushResult>
  createDraftPR(workspace: Workspace, opts: { title: string; body: string }): Promise<DraftPrResult>
}
```

The only built-in adapter is `FileSystemWorkspaceGateway`
(`packages/core/src/workspace/adapters/fs-workspace-gateway.ts`) which
composes — not inherits — the existing `WorkspaceManager` facade.

---

## Internal Composition (v0.2+)

`WorkspaceManager` is now a thin facade over three focused modules
(`packages/core/src/workspace/`):

| Module | Role |
|---|---|
| `worktree-lifecycle.ts` | Worktree creation, lookup, metadata persistence, cleanup, branch / key derivation, diff-against-main detection. |
| `delivery-strategy.ts` | `merge` mode fast-forward rebase + push; `pr` mode branch push + safety-net draft PR (via `gh` CLI). |
| `safety-net.ts` | Auto-commit of uncommitted agent work before delivery; regeneratable-lockfile conflict retry hints. |

The split keeps every file under the 500-line constraint and lets each
module be tested independently (`worktree-lifecycle.test.ts`,
`delivery-strategy.test.ts`, `workspace-safety-net.test.ts`) while
`FileSystemWorkspaceGateway` remains the single shape the orchestrator
depends on.

---

## Workspace Key Derivation

Replace all characters outside the `[A-Za-z0-9._-]` range in `Issue.identifier` with `_`.

```
key = identifier.replace(/[^A-Za-z0-9._-]/g, '_')
```

| Input (identifier) | Output (key) |
|---|---|
| `ACR-42` | `ACR-42` |
| `ACR 42` | `ACR_42` |
| `ACR/42` | `ACR_42` |
| `ACR#42` | `ACR_42` |
| `ACR.feature.1` | `ACR.feature.1` |

---

## Directory Structure

```
{WORKSPACE_ROOT}/
└── {workspace_key}/          ← Per-issue isolated directory
    ├── .git                  ← git worktree link (connected to main repo)
    ├── src/                  ← Code that the agent works on
    └── .symphony/
        ├── attempts/         ← RunAttempt records (JSON)
        └── logs/             ← Agent execution logs
```

`WORKSPACE_ROOT` is read from `Config.workspace.rootPath`.

---

## git worktree Integration

Each Workspace is configured as an independent git worktree.

```
# On creation
git worktree add {workspace_path} -b {branch_name}

# Branch naming convention
branch_name = "symphony/{workspace_key}"
# e.g., symphony/ACR-42
```

**Prerequisite:** A git repository must exist in the parent directory of `WORKSPACE_ROOT` or at the specified main repo path.

---

## Lifecycle Hooks

Each hook is called by the Orchestrator. On hook failure, an error is logged and propagated to the caller.

### onCreate(issue: Issue) → Workspace

```
1. Derive Workspace Key
2. Create directory: mkdir -p {WORKSPACE_ROOT}/{key}/.symphony/attempts
3. git worktree add {path} -b symphony/{key}
4. Create Workspace object (status: "idle")
5. Log: workspace created for issue {identifier}
```

### onStart(workspace: Workspace) → void

```
1. workspace.status = "running"
2. Log: workspace started for issue {identifier}
```

### onComplete(workspace: Workspace, attempt: RunAttempt) → void

```
1. workspace.status = "done"
2. Save RunAttempt record: {path}/.symphony/attempts/{attempt.id}.json
3. Log: workspace completed for issue {identifier}, exitCode: 0
```

### onFailed(workspace: Workspace, attempt: RunAttempt) → void

```
1. workspace.status = "failed"
2. Save RunAttempt record (including exitCode)
3. Log: workspace failed for issue {identifier}, exitCode: {code}
```

### onCleanup(workspace: Workspace) → void

```
1. git worktree remove {path} --force
2. Delete directory: rm -rf {path}
3. Remove Workspace object
4. Log: workspace cleaned up for issue {identifier}
```

---

## Cleanup Policy

Completed or failed Workspaces are automatically deleted after the configured retention period.

```
Retention period: config.workspace.retentionDays (default: 7 days)
Cleanup trigger: Orchestrator's periodic timer or check after webhook event
Condition: workspace.status in ["done", "failed"] AND (now - finishedAt) > retentionDays
```

**Manual cleanup:** See `scripts/harness/gc.sh` script.

---

## Interface Summary

```
WorkspaceManager {
  create(issue: Issue)          → Workspace
  get(issueId: string)          → Workspace | null
  markRunning(workspace)        → void
  markDone(workspace, attempt)  → void
  markFailed(workspace, attempt)→ void
  cleanup(workspace)            → void
  listExpired()                 → Workspace[]   // List of workspaces past retention period
}
```

Depends on: `Config.workspace` (rootPath, keyPattern, retentionDays)
