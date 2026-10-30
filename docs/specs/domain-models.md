# Domain Models

> Core domain model definitions shared by all Symphony components.
> Other spec files reference this file and do not redefine these models.

---

## Issue

Issue data retrieved from Linear. Read-only. Symphony does not write this value.

```
Issue {
  id          : string   // Linear UUID (e.g., "a1b2c3d4-...")
  identifier  : string   // Team-based identifier (e.g., "ACR-42")
  title       : string
  description : string   // Issue body — trust level: low (prompt injection possible)
  status      : {
    id   : string        // Linear status UUID
    name : string        // Display name (e.g., "In Progress")
    type : string        // "started" | "completed" | "cancelled" | "backlog" | "unstarted"
  }
  team        : {
    id  : string         // Linear team UUID
    key : string         // Team identifier (e.g., "ACR")
  }
  url         : string   // Linear issue URL
}
```

**Trust level:**
- `Issue.title`, `Issue.description` — always suspect. Validate at the boundary before inserting into prompts.
- `Issue.id`, `Issue.identifier`, `Issue.status`, `Issue.team` — Linear API response values. Trusted internally.

---

## Workspace

Per-issue isolated workspace. Created and owned by WorkspaceManager.

```
Workspace {
  issueId   : string   // References Issue.id
  path      : string   // Absolute path (e.g., "/var/workspaces/ACR-42")
  key       : string   // Derived key (see rules below)
  status    : "idle" | "running" | "done" | "failed"
  createdAt : ISO8601 string
}
```

**Workspace Key derivation rules:**

Replace all characters outside the `[A-Za-z0-9._-]` range in `Issue.identifier` with `_`.

| Input (identifier) | Output (key) |
| ------------------ | ------------ |
| `ACR-42`           | `ACR-42`     |
| `ACR 42`           | `ACR_42`     |
| `ACR/42`           | `ACR_42`     |
| `ACR#42`           | `ACR_42`     |
| `ACR.42`           | `ACR.42`     |

Directory path: `{WORKSPACE_ROOT}/{workspace_key}/`

---

## RunAttempt

Record of a single agent execution. Tracks from start to finish.

```
RunAttempt {
  id             : string          // UUID v4
  issueId        : string          // References Issue.id
  workspacePath  : string          // Absolute workspace path used for execution
  startedAt      : ISO8601 string
  finishedAt     : ISO8601 string | null  // null while running
  exitCode       : number | null          // Set after completion. 0 = success
  agentOutput    : string | null          // Agent final output (stdout summary)
}
```

---

## LiveSession

Tracks currently running agent processes. Managed by the Orchestrator via heartbeats.

```
LiveSession {
  attemptId      : string          // References RunAttempt.id
  pid            : number          // OS process ID
  startedAt      : ISO8601 string
  lastHeartbeat  : ISO8601 string  // Time of last heartbeat received
}
```

**Purpose:** Detect orphan processes during restart recovery. Sessions are invalidated when `lastHeartbeat` exceeds the threshold.

---

## RetryEntry

Retry scheduling information for failed issues. Used by the Orchestrator retry queue.

```
RetryEntry {
  issueId      : string   // References Issue.id
  attemptCount : number   // Cumulative attempt count
  nextRetryAt  : ISO8601 string  // Retry after this time
  lastError    : string   // Summary of last failure reason
}
```

**Retry policy:** Follows the `agent.retryPolicy` configuration in `config-layer.md`.

---

## OrchestratorRuntimeState

Runtime state held exclusively in memory by the Orchestrator.
**This state is not persisted.** On restart, it is reconstructed via a startup sync (one-time API call to Linear).

```
OrchestratorRuntimeState {
  isRunning        : boolean
  activeWorkspaces : Map<issueId: string, Workspace>
  retryQueue       : RetryEntry[]
  lastEventAt      : ISO8601 string | null
}
```

**Restart recovery strategy:**
1. On restart, `activeWorkspaces` and `retryQueue` are initialized empty.
2. Startup sync: one-time query to Linear for current `IN_PROGRESS` issues.
3. Reconstruct `activeWorkspaces` based on the retrieved issues.
4. If existing `RunAttempt` records are found, resume processing; otherwise create a new `RunAttempt`.

---

## Model reference relationships

```
Issue (1) ──────── (N) Workspace
Issue (1) ──────── (N) RunAttempt
Issue (1) ──────── (0..1) RetryEntry
RunAttempt (1) ─── (0..1) LiveSession

OrchestratorRuntimeState
  └── activeWorkspaces: Map<issueId → Workspace>
  └── retryQueue: RetryEntry[]
```
