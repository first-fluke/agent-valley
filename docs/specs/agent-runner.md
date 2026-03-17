# Agent Runner

> Responsibility: Manage agent process lifecycle via the AgentSession abstraction.
> SRP: Owns session creation, execution, and cleanup. Retry decisions are the Orchestrator's responsibility.

Domain models: see `domain-models.md` (RunAttempt, LiveSession).

---

## AgentSession Abstraction

The Agent Runner does not communicate with agents directly. It uses the `AgentSession` interface, which each agent implements using its native protocol.

```
Orchestrator → AgentRunner → AgentSession interface
                                ├── CodexSession  → codex app-server (JSON-RPC over stdio)
                                ├── ClaudeSession → claude (NDJSON stream-json)
                                └── GeminiSession → gemini (ACP or CLI fallback)
```

### Supported Agents

Select via `AGENT_TYPE` environment variable (or `agent.type` in `WORKFLOW.md`).

| `AGENT_TYPE` | Session | Native Protocol | Model Override |
|---|---|---|---|
| `codex` | `CodexSession` | JSON-RPC 2.0 over stdio (`codex app-server`) | `CODEX_MODEL` |
| `claude` | `ClaudeSession` | NDJSON streaming (`claude --print --input-format=stream-json`) | `CLAUDE_MODEL` |
| `gemini` | `GeminiSession` | ACP experimental or CLI fallback (`gemini --yolo`) | `GEMINI_MODEL` |

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
2. await session.start(config)          // spawn agent process
3. await session.execute(prompt)        // send rendered prompt
4. session.on("complete", handleResult) // listen for completion
5. session.on("error", handleError)     // listen for errors
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
Agent-specific:   codex → OPENAI_API_KEY
                  claude → ANTHROPIC_API_KEY
                  gemini → GOOGLE_API_KEY, GEMINI_API_KEY
Explicit extras:  config.env (passed through AgentConfig)
```

No other host environment variables are forwarded.

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
- **GeminiSession**: any stdout activity or process PID check

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
