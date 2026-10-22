# Agent Runner

> Responsibility: Manage execution lifecycle via the `AgentRunnerPort` abstraction.
> SRP: Owns session creation, execution, and cleanup. Retry decisions are the Orchestrator's responsibility.

Domain models: see `domain-models.md` (RunAttempt, LiveSession).

---

## Domain Port (v0.2+)

The Application layer spawns agents through `AgentRunnerPort`
(`packages/core/src/domain/ports/agent-runner.ts`):

```typescript
interface AgentRunnerPort {
  spawn(input: SpawnInput): Promise<RunHandle>
  capabilities(agentType: string): InterventionCapability[]
}

interface RunHandle {
  readonly attemptId: string
  readonly issueKey: string
  readonly result: Promise<RunAttempt>
  readonly executionCapabilities: {
    cancellation: "confirmed" | "request-only" | "unsupported"
    forceStop: boolean
    reconnect: boolean
  }
  onEvent(handler: (event: AgentRunEvent) => void): Unsubscribe
  send(cmd: InterventionCommand): Promise<void>
  cancel(): Promise<void>
  kill(): Promise<void>
  isAlive(): boolean
}

type InterventionCommand =
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "append_prompt"; text: string }
  | { kind: "abort"; reason: string }

type InterventionCapability = "pause" | "resume" | "append_prompt" | "abort"
```

The default local adapter is `SpawnAgentRunnerAdapter`
(`packages/core/src/sessions/adapters/spawn-agent-runner.ts`) which wraps
the existing process-spawning `AgentRunnerService`. The orchestrator also
consumes the adapter's static capability table so the dashboard can
pre-disable unsupported intervention controls:

```
claude       → ["append_prompt", "abort"]               (stateless; pause/resume absent)
codex        → ["pause", "resume", "append_prompt", "abort"]
antigravity  → ["append_prompt", "abort"] conservatively (stateless)
cursor       → ["append_prompt", "abort"] conservatively (stateless)
grok         → ["append_prompt", "abort"] conservatively (stateless)
kimi         → ["append_prompt", "abort"] conservatively (stateless)
opencode     → ["append_prompt", "abort"] conservatively (stateless)
```

`send()` rejects with `InterventionUnsupportedError` when the command is
outside the advertised set. For `append_prompt` on a stateless agent
(Claude), the upper-layer `InterventionBus` cancels the session and
re-queues the issue with the appended instruction.

`SpawnInput` accepts a caller-owned `attempt`, `model`, explicitly allowed `env`,
`signal` and diagnostic `stage`. The caller persists the attempt before dispatch.
`RunHandle.result` returns the full attempt, including output and observed usage;
`AgentRunError` preserves that attempt on failure and marks uncertain outcomes.
The local adapter replays start and terminal lifecycle events to late subscribers.
Output events are live observations and are not replayed.

A local result settles only after that attempt's startup and disposal have joined.
Cancelling one attempt does not stop concurrent attempts on the same service.
`isAlive()` is an activity observation; callers still join `result` before reading
the workspace. Check execution capabilities before requesting force-stop or
assuming cancellation confirms termination. Request-only or unsupported
cancellation cannot authorize another writer or reviewer.

Chief uses this port too. Its default adapter binds local process guards in
`chief/local-runner.ts`; verification shell commands retain their local guards.
Mission state, budgets, retries and checkpoints stay in AV. Durable run records
separate execution state (`running`, `settled`, `unknown`) from review outcome.
Unknown injected executions require reconciliation before restart can dispatch
work. The independent A2A backend below uses separate AV execution records; see the
[runtime decision](../decisions/adr-runtime-execution-and-state-ownership.md) for
A2A adoption gates.

`reconcileExecution(mission, runId, evidence)` in `chief/execution.ts` records
explicit termination evidence and leaves the run failed, with task reviews,
external effects and unknown costs still independent. Operators can record this
evidence with `av missions reconcile MISSION_ID --run RUN_ID --evidence TEXT`.
The command acquires the mission lock, checks local process guards and saves the
record while leaving the mission paused. It records operator-provided evidence
without independently verifying remote termination. Resume remains an explicit
action after effects, reviews and costs have been inspected. Default local runs
can also be reconciled when
`MissionStore.recoverProcesses` clears their matching process marker and proves
termination. A missing marker cannot establish termination for an unknown run.

### Independent A2A backend

`A2aAgentRunnerAdapter` implements the same port for the
[A2A specification 1.0.1](https://a2a-protocol.org/v1.0.1/specification/), using
JSON-RPC methods `SendMessage`, `GetTask` and `CancelTask` with wire version
`A2A-Version: 1.0`. It supports `abort`, confirmed cancellation after a terminal
Task observation, and durable reconnect. It has no process ID or force-stop.
Unsupported interventions fail explicitly. An acknowledgement, timeout or
missing Task cannot establish termination.

`av a2a run/resume/status/reconcile` composes the adapter with an AV-owned
`A2aJobStore`, an inline file artifact gate and local verification. Its initial
record and request digest precede submission; the accepted Task ID precedes
polling. Accepted tasks resume through `GetTask`. A taskless uncertain
submission remains blocked and cannot be sent again. Operator reconciliation
records termination separately from successful delivery.

The endpoint is explicitly pinned in a strict JSON configuration. HTTPS,
same-origin Agent Card discovery, declared JSONRPC 1.0 interface/tenant,
supported authentication, redirect refusal, time limits and bounded payloads
are enforced by the transport adapter. Only an environment-variable name is
stored for the optional Bearer credential. HTTP requires an explicit literal
loopback development setting. Returned URLs and raw attachments are not fetched.

The operator fixes exact allowed paths and a local verification command before
submission. AV binds complete file bytes and SHA-256 values to the execution,
request, repository and base revision; rejects metadata, credentials,
symlinks and paths outside that allowlist; and journals application for restart.
It rechecks the Git revision, delivered file images and workspace fingerprint
after local verification and joins the verifier process group before completion.
Unconfirmed cleanup keeps the record unknown and blocks a subsequent writer.

This backend does not automatically select remote actors for Chief stages.
Chief Mission transitions, approvals and budgets remain in the existing
coordinator. See [remote A2A execution](../guides/a2a-execution.md) for the command
and artifact contracts. Local HTTP protocol fixtures exercise recovery and
artifact checks; qualifying an external endpoint is a separate deployment check.

---

## AgentSession Abstraction

The Agent Runner does not communicate with agents directly. It uses the `AgentSession` interface, which each agent implements using its native protocol.

```
Orchestrator → AgentRunner → AgentSession interface
                                ├── CodexSession  → codex app-server (JSON-RPC over stdio)
                                ├── ClaudeSession → claude (NDJSON stream-json)
                                ├── AgySession    → agy (Antigravity, one-shot print mode)
                                ├── CursorSession → cursor-agent (streaming NDJSON)
                                ├── GrokSession   → grok (Grok Build, streaming NDJSON)
                                ├── KimiSession   → kimi (Kimi Code, streaming NDJSON)
                                └── OpencodeSession → opencode (multi-provider, streaming NDJSON)
```

### Supported Agents

Select via `AGENT_TYPE` environment variable (or `agent.type` in `WORKFLOW.md`).

| `AGENT_TYPE` | Session | Native Protocol | Model Override |
|---|---|---|---|
| `codex` | `CodexSession` | JSON-RPC 2.0 over stdio (`codex app-server`) | `CODEX_MODEL` |
| `claude` | `ClaudeSession` | NDJSON streaming (`claude --print --input-format=stream-json`) | `CLAUDE_MODEL` |
| `antigravity` | `AgySession` | One-shot print mode, plain text stdout (`agy -p --dangerously-skip-permissions`) | via `config.model` (no `AGENT_MODEL` env override) |
| `cursor` | `CursorSession` | Streaming NDJSON (`cursor-agent -p --output-format stream-json`) | via `config.model` (no `AGENT_MODEL` env override) |
| `grok` | `GrokSession` | Streaming NDJSON (`grok --single --output-format streaming-json`) | not supported — Grok Build has no per-invocation `--model` flag |
| `kimi` | `KimiSession` | Streaming NDJSON (`kimi -p --output-format stream-json`) | via `config.model` (no `AGENT_MODEL` env override) |
| `opencode` | `OpencodeSession` | Streaming NDJSON, multi-provider (75+ backends) | via `config.model` (no `AGENT_MODEL` env override) |

### SessionFactory

```typescript
import { createSession, registerSession } from "./sessions"

// Built-in sessions are registered at startup
const session = createSession("claude")  // → ClaudeSession

// Community extensions
registerSession("aider", () => new AiderSession())
```

---

## AgentSession Interface

```typescript
interface AgentSession {
  start(config: AgentConfig): Promise<void>
  execute(prompt: string): Promise<void>
  cancel(): Promise<void>
  kill(): Promise<void>
  isAlive(): boolean
  on(event: AgentEventType, handler: (event: AgentEvent) => void): void
  off(event: AgentEventType, handler: (event: AgentEvent) => void): void
  dispose(): Promise<void>
}
```

### Events

| Event | Description |
|---|---|
| `output` | Streaming text chunk from agent |
| `toolUse` | Agent invoked a tool (shell, file edit, etc.) |
| `fileChange` | Agent created/modified/deleted a file |
| `heartbeat` | Agent is alive (derived from protocol activity) |
| `complete` | Agent finished execution (includes RunResult) |
| `error` | Agent failed (includes AgentError with recoverable flag) |

### RunResult

```typescript
interface RunResult {
  exitCode: number
  output: string          // max 10KB, truncated
  durationMs: number
  filesChanged: string[]
  tokenUsage?: { input: number; output: number }
}
```

---

## Session Lifecycle

```
1. session = createSession(config.agent.type)
2. session.on("complete", handleResult) // subscribe before execution
3. session.on("error", handleError)
4. await session.start(config)          // spawn agent process
5. await session.execute(prompt)        // send rendered prompt
6. // On timeout:
   await session.cancel()               // SIGTERM
   // wait 10 seconds
   if (session.isAlive()) await session.kill()  // SIGKILL
7. await session.dispose()              // cleanup
```

---

## Environment Security

Agent processes receive a **minimal allowlisted environment**, not the full host env.

```
Safe system vars: PATH, HOME, SHELL, LANG, TERM, TMPDIR, GIT_AUTHOR_*
Agent-specific:   codex → OPENAI_API_KEY, CODEX_HOME
                  claude → ANTHROPIC_API_KEY
                  antigravity (and its "agy" CLI key) → GOOGLE_API_KEY, GEMINI_API_KEY
                  cursor → CURSOR_API_KEY
                  grok → XAI_API_KEY, GROK_API_KEY
                  kimi → KIMI_API_KEY, MOONSHOT_API_KEY (kimi primarily
                    authenticates via ~/.kimi-code/config.toml + `/login`
                    device-code; these env vars are forwarded for
                    parity/CI when present)
                  opencode → ANTHROPIC_API_KEY, OPENAI_API_KEY,
                    OPENROUTER_API_KEY (multi-provider, 75+ backends;
                    ~/.local/share/opencode/auth.json via `opencode auth`
                    is primary, these are convenience passthroughs)
Explicit extras:  config.env (passed through AgentConfig)
```

No other host environment variables are forwarded.

Sandbox planning receives the same allowlisted environment as the actual
subprocess. For Codex, a forwarded `CODEX_HOME` selects the active writable
profile, including account-manager profiles outside `~/.codex`. It must resolve
to an existing absolute directory distinct from the user's home and its
ancestors. Without an override, the native default remains `~/.codex`.
An unforwarded host value does not grant an additional sandbox path.
On macOS, Codex also receives read access to the `apple.cfprefs.` shared-memory
namespace used by its native configuration loader. This permits repeated
managed-preference reads without granting shared-memory writes or changing the
active account's settings.

---

## Timeout Handling

```
When config.agent.timeout seconds elapse:
  1. await session.cancel()  → SIGTERM (or RPC cancel for Codex)
  2. Wait 10 seconds
  3. If session.isAlive() → await session.kill()  → SIGKILL
  4. AgentError emitted with code: "TIMEOUT", recoverable: true
  5. Log: agent timed out for attempt {id}, issueId: {issueId}
```

---

## Heartbeat

Each session emits `heartbeat` events based on its native protocol activity:
- **CodexSession**: any JSON-RPC server notification counts as heartbeat
- **ClaudeSession**: any stream-json output activity counts as heartbeat
- **AgySession / CursorSession / GrokSession / KimiSession / OpencodeSession**: any stdout activity or process PID check

```
Orphan detection: 2 × agent.timeout without heartbeat → force kill + retry
```

---

## RunAttempt Recording

On `complete` event:

```
attempt.finishedAt  = now
attempt.exitCode    = result.exitCode
attempt.agentOutput = result.output (max 10KB, truncated)
attempt.filesChanged = result.filesChanged
```

---

## SPEC Section 17 Test Matrix

| # | Scenario | Input | Expected | Verification |
|---|---|---|---|---|
| 17.1 | Normal execution | Valid issue + workspace | complete event, exitCode: 0 | RunAttempt.exitCode == 0 |
| 17.2 | Agent failure | Unprocessable issue | error event, recoverable: true | RetryEntry created |
| 17.3 | Timeout | timeout=5s, long task | cancel → kill | exitCode: -1, error.code == "TIMEOUT" |
| 17.4 | Process crash | Agent abnormal exit | error event, code: "CRASH" | RunAttempt.exitCode != 0 |
| 17.5 | Concurrency limit | maxParallel=2, 3 issues | Only 2 sessions started | 3rd waits |
| 17.6 | Retry queue | Failure + nextRetryAt reached | Re-executed | attemptCount incremented |
| 17.7 | Max retries exceeded | maxAttempts=3, 3 failures | Halted | Workspace.status == "failed" |
| 17.8 | Restart recovery | Orchestrator restart | Startup sync | Existing workspace reused |
| 17.9 | WORKFLOW.md change | File change detected | Rolling restart | Current sessions complete first |
| 17.10 | Prompt injection | Malicious issue body | Sanitized | Sanitize before session.execute() |
| 17.11 | Graceful shutdown | SIGTERM | Complete current sessions | No in-progress attempt lost |
| 17.12 | Env isolation | Agent process env | Minimal allowlist | No host secrets leaked |

---

## Adding a New Agent

1. Implement the `AgentSession` interface in `src/sessions/your-session.ts`
2. Register in `src/sessions/session-factory.ts`:
   ```typescript
   registerSession("your-agent", () => new YourSession())
   ```
3. Add agent-specific env keys to `AGENT_ENV_KEYS` in `base-session.ts`
4. Set `AGENT_TYPE=your-agent` in `.env`
5. No Orchestrator code changes required
