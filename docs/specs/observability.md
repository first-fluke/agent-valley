# Observability

> Responsibility: Structured log output, metrics collection, optional status surface.
> SRP: Log and metrics infrastructure only. Business logic is each component's responsibility.

---

## Log Format

Controlled by the `LOG_FORMAT` environment variable.

```
LOG_FORMAT=json   → JSON format (recommended for production)
LOG_FORMAT=text   → Human-readable text (default, for development)
```

### JSON Format Example

```json
{
  "timestamp": "2026-03-16T10:30:00.000Z",
  "level": "info",
  "component": "orchestrator",
  "issueId": "a1b2c3d4-...",
  "message": "agent started for issue ACR-42"
}
```

### Text Format Example

```
2026-03-16T10:30:00.000Z [INFO] [orchestrator] agent started for issue ACR-42 issueId=a1b2c3d4-...
```

---

## Required Log Fields

Every log event must include:

| Field | Type | Description |
|---|---|---|
| `timestamp` | ISO8601 | Event time (UTC) |
| `level` | string | Log level |
| `component` | string | Component that emitted the log |
| `message` | string | Event description |
| `issueId` | string | Issue ID (when relevant) |

**Optional fields:** `attemptId`, `workspacePath`, `exitCode`, `durationMs`, `error`

---

## Log Levels

Controlled by `LOG_LEVEL` environment variable. Only messages at or above the set level are output.

| Level | When to use |
|---|---|
| `debug` | Webhook payload details, RPC request/response, state transitions |
| `info` | Agent start/complete, workspace create/delete, startup sync, server ready |
| `warn` | Retry triggered, rate limit response, config values near boundary |
| `error` | Agent failure, Linear API auth error, unhandled exception |

Default: `info`

---

## Key Log Events

Events that must be logged during implementation:

```
[orchestrator] startup sync completed, found {n} issues    level: info
[orchestrator] webhook received: {action} for {identifier}  level: debug  + issueId
[orchestrator] starting agent for issue {identifier}        level: info   + issueId
[orchestrator] agent completed for issue {identifier}       level: info   + issueId, exitCode, durationMs
[orchestrator] agent failed for issue {identifier}          level: warn   + issueId, exitCode, error
[orchestrator] retry scheduled for issue {identifier}       level: warn   + issueId, attemptCount, nextRetryAt
[orchestrator] max retries exceeded for {identifier}        level: error  + issueId
[orchestrator] webhook signature invalid                    level: warn   + source IP
[orchestrator] server listening on port {port}              level: info
[workspace-manager] workspace created                       level: info   + issueId, workspacePath
[workspace-manager] workspace cleaned up                    level: info   + issueId, workspacePath
[tracker-client] startup sync failed                        level: error  + error
[tracker-client] rate limit hit                             level: warn   + retryAfterSec
[tracker-client] auth failed                                level: error
[config-layer] config validation failed                     level: error  + error list
[workflow-loader] WORKFLOW.md reloaded                       level: info
```

---

## Metrics Collection Points

Collect metrics at these events:

| Metric | When | Unit |
|---|---|---|
| `webhook_events_received` | Each webhook received | count |
| `webhook_events_processed` | Each webhook successfully handled | count |
| `webhook_signature_failures` | Signature verification failed | count |
| `agent_duration_ms` | RunAttempt completed | milliseconds |
| `agent_success_count` | exitCode == 0 | count |
| `agent_failure_count` | exitCode != 0 | count |
| `retry_count` | Retry queue entry added | count |
| `active_workspaces` | After each event processed | gauge |
| `linear_api_errors` | Linear API error occurred | count |

---

## Optional Status Surface (HTTP Endpoints)

The Orchestrator runs an HTTP server on `Config.server.port` for webhooks and status.

### POST /webhook

Receives Linear webhook events. See `tracker-client.md` for payload format.

### GET /status

```json
{
  "isRunning": true,
  "lastEventAt": "2026-03-16T10:30:00.000Z",
  "activeWorkspaces": [
    {
      "issueId": "a1b2c3d4-...",
      "identifier": "ACR-42",
      "status": "running",
      "startedAt": "2026-03-16T10:25:00.000Z"
    }
  ],
  "retryQueueSize": 1,
  "metrics": {
    "totalAttempts": 42,
    "successCount": 38,
    "failureCount": 4
  }
}
```

### GET /health

```json
{ "status": "ok" }
```

When Linear API is unreachable: `{ "status": "degraded", "reason": "linear api unreachable" }`

**Security:** The status surface must only be accessible from the internal network. Do not expose without authentication.

---

## Optional OTEL Integration

When `OTEL_ENDPOINT` is set, export metrics and traces via OpenTelemetry.

```
OTEL_ENDPOINT=http://collector:4318   → export via OTLP HTTP
OTEL_ENDPOINT not set                 → OTEL disabled (local logs only)
```

**Trace scope:** Each webhook event as a root span, each RunAttempt as a child span.
