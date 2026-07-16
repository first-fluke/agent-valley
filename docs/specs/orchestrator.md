# Orchestrator

> Responsibility: Handle webhook events, manage state machine, process retry queue.
> The core Symphony component. Sole authority over in-memory runtime state.

Domain models: see `domain-models.md` (Issue, Workspace, RunAttempt, RetryEntry, OrchestratorRuntimeState).

---

## Internal Composition (v0.2+)

The Orchestrator is exposed as a single facade class, but internally it is split into four collaborators so responsibilities stay SRP-clean:

| File | Role |
|---|---|
| `orchestrator.ts` | Public facade. Wires collaborators, exposes `start / stop / getHandlers / on / off` and a read-only `intervention` bus. |
| `orchestrator-core.ts` | Owns `OrchestratorRuntimeState` + sub-services (`RetryQueue`, `DagScheduler`, `AgentRunnerService`, `BudgetService`, `ObservabilityHooks`). Sole state-mutation authority. |
| `issue-lifecycle.ts` | State-transition side of event handling: Todo admission, In-Progress dispatch, left-In-Progress kill, retry / blocker re-evaluation. |
| `webhook-router.ts` | Verifies signature, parses via `WebhookReceiver`, dispatches to lifecycle, drains the retry queue after each event. |
| `intervention-bus.ts` | Application-layer mediator for live operator commands (pause / resume / append_prompt / abort). FIFO per attempt. |

The split preserves the v0.1 public surface — external callers (dashboard bootstrap, relay bridge, CLI) continue to construct a single `new Orchestrator(...)`.

---

## State Ownership

The Orchestrator exclusively owns `OrchestratorRuntimeState`.
No other component mutates this state directly. Access is only through the Orchestrator API.

```
OrchestratorRuntimeState (single instance, in-memory)
  isRunning        : boolean
  activeWorkspaces : Map<issueId, Workspace>
  retryQueue       : RetryEntry[]
  lastEventAt      : ISO8601 | null
```

---

## Event-Driven Flow

The Orchestrator is event-driven via Linear webhooks.
On startup, it performs a one-time sync to recover any events missed while offline.

### Startup Sync

```
1. TrackerClient.fetchIssuesByState([todo, inProgress])   ← one-time API call
   → current Todo + In Progress issue list

2. For each issue:
   a. If Todo → handleIssueTodo (transition to InProgress, then start agent)
   b. If InProgress → handleIssueInProgress (start agent directly)

3. Process retry queue (see Retry Queue section)

4. Start HTTP server on Config.server.port
   → /webhook  — receive Linear events
   → /status   — runtime state
   → /health   — health check

5. Ready to receive webhook events
```

### Webhook Event Handling

```
POST /webhook received:
  1. TrackerClient.verifyWebhookSignature(payload, signature)
     → invalid signature: 403 + warn log, discard

  2. TrackerClient.parseWebhookEvent(payload)
     → extract: action, issueId, stateId

  3. Route by event:
     a. Issue moved to TODO:
        → handleIssueTodo:
          - Check if already in activeWorkspaces (skip if duplicate)
          - Check concurrency limit (queue in retryQueue if maxParallel reached)
          - TrackerClient.updateIssueState(issueId, inProgress)
          - Delegate to handleIssueInProgress

     b. Issue moved to IN_PROGRESS:
        → handleIssueInProgress:
          - Check if already in activeWorkspaces (skip if duplicate)
          - Check concurrency limit (queue if maxParallel reached)
          - WorkspaceManager.create(issue) if no workspace
          - AgentRunner.spawn(issue, workspace)
          - Add to activeWorkspaces

     c. Issue moved OUT of IN_PROGRESS (DONE, CANCELLED, etc.):
        → If running in activeWorkspaces, AgentRunner.kill(attemptId)
        → Remove from activeWorkspaces
        → WorkspaceManager.cleanup(workspace) if configured

  4. Return 200 OK (acknowledge receipt)
```

### Agent Completion Handling

```
AgentRunner.spawn() resolves:
  → exitCode == 0:
    - Post-completion (safety-net auto-commit, then work-summary comment)
    - Verification gate (see below) — if configured for this route and it
      fails, fall through to the retryable-failure path instead of Done
    - Delivery (merge/PR)
    - Workspace.status = "done", remove from activeWorkspaces
    - TrackerClient.updateIssueState(issueId, done)

  → exitCode != 0, or verification gate failed (recoverable):
    - Add RetryEntry to retry queue
    - If max retries exceeded:
      - TrackerClient.addIssueComment(issueId, errorReport)
      - TrackerClient.updateIssueState(issueId, cancelled)
```

### Verification Gate (v0.2+)

`packages/core/src/orchestrator/verification-gate.ts`, wired into
`completion-handler.ts` between the work-summary comment and delivery.
When a `verify_command` is resolved for the issue's route (per-route
`routing.rules[].verify_command` overrides the project-wide
`verify.command` — see `packages/core/src/config/verify-schema.ts`), it
runs inside the agent's worktree before delivery and before the Done
transition. This is the external check that replaces agent
self-assessment: an agent that writes broken code and exits 0 must not be
marked Done or merged on its own say-so. No `verify_command` configured
for the route is a no-op — Done means only that the agent process exited
0, same as before this feature. On failure (non-zero exit or timeout,
default 600s / `verify.timeout_sec`), the run is fed back through the
existing retry queue with the captured output (bounded to 10KB) as
retry-prompt context; once retries are exhausted the issue is cancelled
with an actionable comment instead of being merged.

---

## Restart Recovery

`packages/core/src/orchestrator/persistence/` durably snapshots in-flight
run state to `${workspaceRoot}/.agent-valley/run-state.json`
(`run-state-store.ts`, mirroring `DagScheduler`'s JSON-cache pattern),
mutated only by `OrchestratorCore` — the same "sole state authority"
invariant that applies to the in-memory state. On boot, before startup
sync runs, `OrchestratorCore.recoverFromPersistedState()` loads the
snapshot and applies a PID-liveness decision (`decideRecovery()` in
`packages/core/src/orchestrator/persistence/recovery.ts`) to each persisted active attempt:

```
1. Load run-state.json (missing/corrupt file → empty snapshot, not an error)
2. For each persisted active attempt:
   a. pid known AND process.kill(pid, 0) succeeds → reattach (block a duplicate spawn)
   b. pid unknown, or the liveness probe fails/errors → reap (clean up so the
      normal dispatch path can safely restart it exactly once)
3. Restore the persisted retry queue as-is
4. Re-persist the post-recovery state, log reattached/reaped/restoredRetries counts
5. Continue into startup sync (fetch Todo + In Progress issues from Linear)
```

**Current limitation:** `AgentRunnerService`/`AgentSession` do not yet
surface the spawned child process's OS pid past their own module
boundary, so `pid` is always persisted as `null` today. `decideRecovery()`
conservatively treats a `null` pid as "cannot verify liveness" and reaps
it — every restart currently re-dispatches in-flight issues rather than
reattaching to a still-alive process, but it does so exactly once via the
persisted retry/active-attempt bookkeeping instead of silently losing
track of them. Threading a real pid through `RunOptions`/`RunCallbacks`
is a tracked follow-up, not yet implemented.

**Orphan process handling:** If LiveSession.lastHeartbeat exceeds `2 * agent.timeout`, treat as orphan. Terminate OS process, add to retry queue.

---

## Retry Queue

```
On failure:
  RetryEntry {
    issueId      = issue.id
    attemptCount = previous attempt count + 1
    nextRetryAt  = now + (backoffSec * 2^(attemptCount-1))  // exponential backoff
    lastError    = runner exit code + last error message
  }

  if attemptCount >= config.agent.retryPolicy.maxAttempts:
    → do not add to retry queue
    → error log: "Max retry attempts reached for issue {identifier}"
    → Workspace.status = "failed"
```

Retry queue is processed:
- After startup sync completes
- After each webhook event is handled
- On a periodic timer (every `retryCheckIntervalSec`, default: 30s)

---

## Workspace State Machine

```
        create()
idle ──────────────→ running
                         │
              exitCode==0 │ exitCode!=0
                    ↓     ↓
                  done   failed → (retry: back to running)
```

State transitions are performed by the Orchestrator only.

---

## SPEC Section 18.1 Implementation Checklist

Verify Symphony SPEC Section 18.1 compliance during implementation.

| # | Item | Description |
|---|---|---|
| 18.1.1 | Single Orchestrator instance | Only one Orchestrator per process |
| 18.1.2 | Webhook-driven event handling | React to Linear webhook events (no polling) |
| 18.1.3 | Startup sync | One-time Linear API call on start to recover missed events |
| 18.1.4 | Concurrency limit enforced | Block new runs when `maxParallel` is reached |
| 18.1.5 | Duplicate run prevention | No concurrent RunAttempts for the same issueId |
| 18.1.6 | Retry queue is durably persisted | Snapshotted to `${workspaceRoot}/.agent-valley/run-state.json` on every add/remove/drain; restored on boot before startup sync (see Restart Recovery) |
| 18.1.7 | Restart recovery | Persisted run-state snapshot + PID-liveness check reconciles active attempts, then startup sync restores state from Linear + existing workspaces |
| 18.1.8 | Timeout enforced | Force-kill runner when `agent.timeout` is exceeded |
| 18.1.9 | Max retries enforced | Stop retrying after `retryPolicy.maxAttempts` |
| 18.1.10 | Scheduling state writes | Orchestrator manages Todo→InProgress, InProgress→Done/Cancelled transitions |
| 18.1.11 | Structured logging | All events logged per `observability.md` format |
| 18.1.12 | Graceful shutdown | On SIGTERM, complete current RunAttempts before exit |
| 18.1.13 | Config change reload | Detect WORKFLOW.md changes, finish current runs, then reload |
| 18.1.14 | Webhook signature verification | Reject unsigned or tampered webhook payloads |

---

## Interface Summary

```
Orchestrator {
  start()   → void   // start HTTP server, run startup sync, begin accepting webhooks
  stop()    → void   // graceful shutdown (SIGTERM)
  status()  → OrchestratorRuntimeState  // read-only current state
}
```

Dependencies: TrackerClient, WorkspaceManager, AgentRunner, Observability
Config: `Config.concurrency`, `Config.agent.retryPolicy`, `Config.workflowStates`, `Config.server`
