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

## Optional OTEL Integration (v0.2+)

OpenTelemetry OTLP HTTP tracing is built in but defaults to **off**.
Enable per deployment via `valley.yaml`:

```yaml
observability:
  otel:
    enabled: true
    endpoint: http://localhost:4318     # OTLP HTTP collector
    service_name: agent-valley
```

**Trace scope:** Each webhook event as a root span; agent start / done /
failed / cancelled + DAG cycle detection + retry queue size changes
become spans and counters on that root. Exporter errors are swallowed
inside the hooks and never propagate into orchestrator flow.

Implementation: `packages/core/src/observability/otel-exporter.ts`.

---

## Optional Prometheus Integration (v0.2+)

A Prometheus metrics endpoint is built in but defaults to **off**. Enable
via `valley.yaml`:

```yaml
observability:
  prometheus:
    enabled: true
    path: /api/metrics
```

| Metric | Type | Description |
|---|---|---|
| `agent_valley_active_agents` | gauge | Agents currently running |
| `agent_valley_retry_queue_size` | gauge | Pending retry entries |
| `agent_valley_agent_started_total` | counter | Spawn events, labelled by `agent_type` |
| `agent_valley_agent_done_total` | counter | Successful completions |
| `agent_valley_agent_failed_total` | counter | Failures with `retryable` label |
| `agent_valley_agent_cancelled_total` | counter | Cancellations |
| `agent_valley_agent_duration_ms` | histogram | Agent run duration |
| `agent_valley_dag_cycles_total` | counter | DAG cycle detections |

Served as text/plain from `GET /api/metrics` through the Presentation
layer (`apps/dashboard/src/app/api/metrics/route.ts`). When Prometheus is
disabled, the endpoint returns HTTP 503 with an actionable error body.

Implementation: `packages/core/src/observability/prom-metrics.ts`.
