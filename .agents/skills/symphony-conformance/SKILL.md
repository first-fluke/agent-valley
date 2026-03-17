---
name: symphony-conformance
description: Audits the current implementation for Symphony SPEC compliance and architecture rule adherence. Use when user asks to "check conformance", "audit symphony", or "verify spec compliance".
---

# Symphony Conformance

## When to use

- User asks to check, audit, or verify the current implementation against Symphony SPEC
- User wants a conformance report before merging or deploying
- CI or review process requires a SPEC compliance gate

## When NOT to use

- Implementing a new component -> use Symphony Component skill
- Starting a new project -> use Symphony Scaffold skill

## Checks

Run each check in order and record pass or fail. Produce a report at the end.

### 1. All 7 components exist

Verify that skeleton or complete implementations exist for each component:

- Workflow Loader
- Config Layer
- Issue Tracker Client
- Orchestrator
- Workspace Manager
- Agent Runner
- Observability

A component "exists" if there is a non-empty source file in the correct layer directory that exports the component's interface.

### 2. Architecture layers not violated

Run the validation script:

```bash
./scripts/harness/validate.sh
```

The script checks for dependency direction violations per `docs/architecture/LAYERS.md` and forbidden patterns from `docs/architecture/CONSTRAINTS.md`. Report any violations with file and line references.

### 3. WORKFLOW.md parses correctly

Locate the project's `WORKFLOW.md` and verify:
- YAML front matter is valid
- Required fields are present (reference `docs/specs/workflow-loader.md` for required fields)
- Prompt body is non-empty

### 4. Config layer validates all required env vars

Verify that the Config Layer implementation checks for all variables listed in `AGENTS.md` § Build & Test:

- `LINEAR_API_KEY`
- `LINEAR_TEAM_ID`
- `LINEAR_TEAM_UUID`
- `LINEAR_WORKFLOW_STATE_IN_PROGRESS`
- `LINEAR_WORKFLOW_STATE_DONE`
- `LINEAR_WORKFLOW_STATE_CANCELLED`
- `WORKSPACE_ROOT`
- `LOG_LEVEL`

Each missing variable must produce an error message that names the variable and states where to set it.

### 5. Orchestrator: single instance, polling loop, retry queue

Review the Orchestrator implementation against `docs/specs/orchestrator.md` SPEC Section 18.1 checklist:

- 18.1.1: Single Orchestrator instance per process
- 18.1.2: Webhook-driven event handling (no polling)
- 18.1.3: `maxParallel` concurrency limit is enforced
- 18.1.4: Duplicate run prevention for the same issueId
- 18.1.5: Retry queue is in-memory only (no persistence)
- 18.1.6: Restart recovery via startup sync (one-time Linear API call)
- 18.1.7: `agent.timeout` enforced with forced runner termination
- 18.1.8: `retryPolicy.maxAttempts` stops retries when exceeded
- 18.1.9: Orchestrator does not write Linear issue state
- 18.1.10: All events logged in structured JSON format
- 18.1.11: SIGTERM triggers graceful shutdown after current RunAttempt
- 18.1.12: WORKFLOW.md change detected and reloaded after current runs complete

### 6. No secrets in code or logs

Search the codebase for hardcoded secrets and log statements that may leak sensitive values:

- No API keys, tokens, or passwords in source files
- No secret values interpolated into log messages
- `.env` is listed in `.gitignore`
- `.env.example` contains only placeholder values

### 7. AGENTS.md up to date

Check the last-modified date of `AGENTS.md`. If it has not been updated within 30 days, flag it as needing review (per `AGENTS.md` § Metrics — Document Freshness).

## Output

Produce a conformance report with the following format:

```
Symphony Conformance Report
===========================

[PASS] 1. All 7 components exist
[FAIL] 2. Architecture layers not violated
       - src/domain/issue.ts imports from infrastructure (line 3): violation
[PASS] 3. WORKFLOW.md parses correctly
[PASS] 4. Config layer validates all required env vars
[FAIL] 5. Orchestrator: single instance, polling loop, retry queue
       - 18.1.9: Orchestrator calls linear.updateIssue() at orchestrator.ts:87
[PASS] 6. No secrets in code or logs
[WARN] 7. AGENTS.md last updated 45 days ago — review recommended

Result: 2 failures, 1 warning
```

## References

- `docs/specs/orchestrator.md` — SPEC Section 18.1 checklist
- `docs/specs/` — all component interface specs
- `docs/architecture/LAYERS.md` — dependency direction rules
- `docs/architecture/CONSTRAINTS.md` — forbidden patterns
- `docs/harness/SAFETY.md` — secrets and security rules
- `AGENTS.md` — conventions, metrics, required env vars
- `scripts/harness/validate.sh` — architecture validation script
