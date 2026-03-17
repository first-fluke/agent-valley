# Tracker Client (Linear GraphQL Adapter)

> Responsibility: Communicate with Linear API, parse webhook events, and convert data to domain models.
> SRP: API communication and data transformation only. State changes are the agent's responsibility. Symphony never writes issue state.

---

## Endpoint

```
POST https://api.linear.app/graphql
```

---

## Authentication

```
Authorization: {LINEAR_API_KEY}
Content-Type: application/json
```

API key is used directly without a `Bearer` prefix.

---

## Webhook Event Handling

Linear sends webhook events to the Orchestrator's `/webhook` endpoint when issue state changes.

### Webhook Payload Structure

```json
{
  "action": "update",
  "type": "Issue",
  "data": {
    "id": "issue-uuid",
    "identifier": "ACR-42",
    "title": "Issue title",
    "description": "Issue description",
    "url": "https://linear.app/...",
    "state": {
      "id": "state-uuid",
      "name": "In Progress",
      "type": "started"
    },
    "team": {
      "id": "team-uuid",
      "key": "ACR"
    }
  },
  "updatedFrom": {
    "stateId": "previous-state-uuid"
  }
}
```

### Signature Verification

Linear signs webhook payloads with HMAC-SHA256 using the webhook secret.

```
Header: Linear-Signature: <hex-encoded HMAC-SHA256>

Verification:
  expected = HMAC-SHA256(LINEAR_WEBHOOK_SECRET, raw_request_body)
  actual   = request.headers["Linear-Signature"]
  → constant-time comparison
  → mismatch: reject with 403
```

### Event Routing

```
parseWebhookEvent(payload) → WebhookEvent {
  action   : "create" | "update" | "remove"
  issueId  : string
  issue    : Issue        (converted to domain model)
  stateId  : string       (current state ID)
  prevStateId : string | null  (previous state ID, from updatedFrom)
}

Orchestrator routes by:
  stateId == Config.workflowStates.inProgress
    → issue moved TO In Progress → start agent
  prevStateId == Config.workflowStates.inProgress && stateId != inProgress
    → issue moved OUT of In Progress → stop agent
```

---

## Startup Sync Query — IN_PROGRESS Issues

On Orchestrator startup, fetch all current IN_PROGRESS issues once to recover missed events.

```graphql
query GetInProgressIssues($teamId: String!, $stateId: ID!) {
  issues(
    filter: {
      team: { id: { eq: $teamId } }
      state: { id: { eq: $stateId } }
    }
    first: 50
  ) {
    nodes {
      id
      identifier
      title
      description
      url
      state {
        id
        name
        type
      }
      team {
        id
        key
      }
    }
  }
}
```

**Variables:**
```json
{
  "teamId": "{LINEAR_TEAM_UUID}",
  "stateId": "{LINEAR_WORKFLOW_STATE_IN_PROGRESS}"
}
```

Convert returned nodes to the `Issue` domain model from `domain-models.md`.

---

## Workflow State IDs

Symphony references these IDs in **read-only** mode.
Actual state changes are performed by agents calling the Linear API directly.

| State | ID | Description |
|---|---|---|
| IN_PROGRESS | `{LINEAR_WORKFLOW_STATE_IN_PROGRESS}` | Agent is running |
| DONE | `{LINEAR_WORKFLOW_STATE_DONE}` | Agent completed successfully |
| CANCELLED | `{LINEAR_WORKFLOW_STATE_CANCELLED}` | Agent failed or cancelled |

**State transition authority:**

```
Agent start    → IN_PROGRESS  (agent sets this)
Agent success  → DONE         (agent sets this)
Agent failure  → CANCELLED    (agent sets this)
```

Symphony (Orchestrator) never changes issue state directly.

---

## Trust Levels

| Data Source | Trust Level | Handling |
|---|---|---|
| `WORKFLOW.md` | High — trusted | Use as-is |
| Linear API response (id, status, team) | Medium — internal trust | Type-validate before use |
| `Issue.title`, `Issue.description` | Low — suspect | Escape before prompt insertion. See `docs/harness/SAFETY.md` |
| Webhook payload | Medium — verify signature | Reject if signature mismatch |

---

## Error Handling

### Invalid Webhook Signature

```
Reject immediately with HTTP 403.
Warn log: "webhook signature verification failed, source={ip}"
Do not process the event.
```

### Rate Limit (HTTP 429) — Startup Sync Only

```
1. Check Retry-After header
2. If absent, apply exponential backoff: 1s, 2s, 4s, ... max 60s
3. After 5 retries, warn log and proceed with empty issue list
```

### Auth Failure (HTTP 401)

```
Halt immediately (no retry).
Error log: "Linear API authentication failed. Check LINEAR_API_KEY in .env"
Process exit (exit code 1)
```

### Network Error (timeout, connection refused)

```
Exponential backoff retry.
3 consecutive failures: warn-level log.
10 consecutive failures: error-level log + signal degraded state to Orchestrator.
```

### GraphQL Error

```
Check errors array.
Auth-related error → halt immediately.
Other → log and skip (webhook events will continue arriving).
```

---

## Interface Summary

```
TrackerClient {
  verifyWebhookSignature(payload: string, signature: string) → boolean
  // Verify HMAC-SHA256 signature. Return false if invalid.

  parseWebhookEvent(payload: string) → WebhookEvent
  // Parse webhook JSON into domain event. Throw on invalid format.

  fetchInProgressIssues() → Issue[]
  // One-time startup sync. Fetch all IN_PROGRESS issues.
  // Throw on error (caller handles).
}
```

Config dependencies: `Config.tracker` (url, apiKey, teamUuid, webhookSecret), `Config.workflowStates`
