# Config Layer

> Responsibility: Build a typed config object and resolve environment variables.
> SRP: Config loading and validation only. Config usage is each component's responsibility.

---

## Config Source Priority

Higher priority overrides lower priority.

```
1. CLI args              (highest)
2. Environment variables (second)
3. WORKFLOW.md front matter  (defaults)
```

**Example:** `--port 9090` CLI arg overrides both `WORKFLOW.md`'s `server.port` and the `SERVER_PORT` env var.

---

## Environment Variable References (`$VAR` Pattern)

In `WORKFLOW.md` front matter, `$VAR_NAME` references an environment variable.
The Config Layer substitutes it with the actual value at load time.

```yaml
tracker:
  apiKey: $LINEAR_API_KEY      # → resolved to process.env.LINEAR_API_KEY
  teamId: $LINEAR_TEAM_ID
workspace:
  rootPath: $WORKSPACE_ROOT
```

- If `$VAR` is not set: treat as error (not empty string).
- Nested references (`$$VAR`) are not supported.
- See `.env.example` for the full variable list.

---

## Typed Config Schema

```
Config {
  tracker: {
    url           : string   // Linear GraphQL endpoint
    apiKey        : string   // Linear Personal API key ($LINEAR_API_KEY)
    teamId        : string   // Linear team identifier ($LINEAR_TEAM_ID)
    teamUuid      : string   // Linear team UUID ($LINEAR_TEAM_UUID)
    webhookSecret : string   // Linear webhook signing secret ($LINEAR_WEBHOOK_SECRET)
  }
  workspace: {
    rootPath      : string   // Workspace root absolute path ($WORKSPACE_ROOT)
    keyPattern    : string   // Key derivation allowed character pattern (default: "[A-Za-z0-9._-]")
    retentionDays : number   // Days to retain completed/failed workspaces (WORKFLOW.md: cleanup_after_days, default: 7)
  }
  agent: {
    type        : string   // Agent type — selects AgentSession impl ($AGENT_TYPE: "claude" | "gemini" | "codex")
    timeout     : number   // Seconds. Force-kill if exceeded
    retryPolicy : {
      maxAttempts : number   // Max retry count (default: 3)
      backoffSec  : number   // Retry interval seconds (default: 60)
    }
  }
  concurrency: {
    maxParallel : number   // Max concurrent agent count
  }
  server: {
    port : number   // HTTP server port for webhooks + status (default: 8080)
  }
  workflowStates: {
    inProgress : string   // Linear "In Progress" state UUID ($LINEAR_WORKFLOW_STATE_IN_PROGRESS)
    done       : string   // Linear "Done" state UUID ($LINEAR_WORKFLOW_STATE_DONE)
    cancelled  : string   // Linear "Cancelled" state UUID ($LINEAR_WORKFLOW_STATE_CANCELLED)
  }
}
```

---

## Required Config Items

Refuse to start if any of the following are missing or empty.

| Config Key | Env Var | Description |
|---|---|---|
| `tracker.apiKey` | `LINEAR_API_KEY` | Linear Personal API key |
| `tracker.teamId` | `LINEAR_TEAM_ID` | Linear team identifier |
| `tracker.teamUuid` | `LINEAR_TEAM_UUID` | Linear team UUID |
| `tracker.webhookSecret` | `LINEAR_WEBHOOK_SECRET` | Linear webhook signing secret |
| `workspace.rootPath` | `WORKSPACE_ROOT` | Workspace root absolute path |
| `workflowStates.inProgress` | `LINEAR_WORKFLOW_STATE_IN_PROGRESS` | "In Progress" state UUID |
| `workflowStates.done` | `LINEAR_WORKFLOW_STATE_DONE` | "Done" state UUID |
| `workflowStates.cancelled` | `LINEAR_WORKFLOW_STATE_CANCELLED` | "Cancelled" state UUID |

---

## Type Validation

Validate the entire config at startup. Reject on any failure.

**Validation checks:**
- Required key existence
- Type matching (string/number)
- Range: `concurrency.maxParallel` >= 1, `agent.timeout` >= 30
- `workspace.rootPath` directory existence
- URL format: `tracker.url`

**Error message format (on validation failure):**

```
Config validation failed. Fix the following issues and restart:

  [1] tracker.apiKey: missing (set LINEAR_API_KEY in .env)
  [2] tracker.webhookSecret: missing (set LINEAR_WEBHOOK_SECRET in .env)
  [3] agent.timeout: must be >= 30, got 10
  [4] workspace.rootPath: directory does not exist: /var/workspaces
      → Create it: mkdir -p /var/workspaces

Symphony cannot start until all config errors are resolved.
```

---

## Full Environment Variable List

See `.env.example`. Key items:

| Env Var | Required | Default | Description |
|---|---|---|---|
| `LINEAR_API_KEY` | Y | — | Linear Personal API key |
| `LINEAR_TEAM_ID` | Y | — | Linear team identifier (e.g. `ACR`) |
| `LINEAR_TEAM_UUID` | Y | — | Linear team UUID |
| `LINEAR_WEBHOOK_SECRET` | Y | — | Linear webhook signing secret |
| `LINEAR_WORKFLOW_STATE_IN_PROGRESS` | Y | — | "In Progress" state UUID |
| `LINEAR_WORKFLOW_STATE_DONE` | Y | — | "Done" state UUID |
| `LINEAR_WORKFLOW_STATE_CANCELLED` | Y | — | "Cancelled" state UUID |
| `WORKSPACE_ROOT` | Y | — | Workspace root absolute path |
| `AGENT_TYPE` | Y | `claude` | Agent to use: claude, gemini, codex |
| `LOG_LEVEL` | N | `info` | Log level (debug/info/warn/error) |
| `LOG_FORMAT` | N | `text` | Log format (text/json) |
| `OTEL_ENDPOINT` | N | — | OpenTelemetry collector endpoint |
