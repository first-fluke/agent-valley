# Changelog

All notable changes to Agent Valley are documented here. This project
follows [Semantic Versioning](https://semver.org/) and
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Commits follow
[Conventional Commits](https://www.conventionalcommits.org/).

## [0.2.0] - 2026-04-22

### Added

- **Domain port layer** — `IssueTracker`, `WebhookReceiver<TEvent>`,
  `WorkspaceGateway`, and `AgentRunnerPort` are first-class domain types.
  Adapters live in `packages/core/src/{tracker,workspace,sessions}/adapters/`.
  Contract tests (`packages/core/src/__tests__/contracts/`) enforce that
  any adapter passes the same behavioural suite.
- **GitHub Issues support** — `GitHubTrackerAdapter` +
  `GitHubWebhookReceiver` + `POST /api/webhook/github`. Selector is
  `tracker.kind` in `valley.yaml`; defaults to `linear`.
- **Agent budget caps** — `BudgetService` evaluates per-issue and
  per-day token / USD limits before each spawn; exceeding a cap
  transitions the issue to `cancelled` with an actionable comment.
  Configure via the new `budget:` section in `valley.yaml`.
- **Live intervention** — `InterventionBus` + `POST /api/intervention`
  for `pause` / `resume` / `append_prompt` / `abort`. Dashboard ships
  an `InterventionPanel` UI. Commands are FIFO per attempt
  (last-writer-wins) and dispatch through a typed capability table
  (`SpawnAgentRunnerAdapter.CAPABILITY_TABLE`).
- **Observability hooks (off by default)** — OpenTelemetry OTLP HTTP
  tracing via `observability.otel.*` and Prometheus `/api/metrics` via
  `observability.prometheus.*`. Covers active agents, retry queue size,
  agent start/done/failed/cancelled counters, duration histogram, and
  DAG cycle detections.
- **ParsedWebhookEvent domain type** — tracker-agnostic webhook event
  union in `packages/core/src/domain/parsed-webhook-event.ts`. Adapters
  translate their native payloads into this union so the router is
  tracker-free.
- **Integration test suite** — `todo-to-done`, `retry-exhaust`, and
  `intervention-flow` end-to-end tests drive the real orchestrator over
  a real temp git repo with fakes only at the tracker + session seams.

### Changed

- **Orchestrator split** — single facade now composes
  `OrchestratorCore` (state authority + sub-services), `IssueLifecycle`
  (state transitions), `WebhookRouter` (signature + dispatch), and
  `InterventionBus`. Public surface (`start / stop / getHandlers`) is
  unchanged.
- **Workspace Manager split** — `WorkspaceManager` is a facade over
  `worktree-lifecycle` / `delivery-strategy` / `safety-net`.
  `FileSystemWorkspaceGateway` composes the facade (no inheritance).
- **`AgentRunnerService` wrapped as `SpawnAgentRunnerAdapter`** — the
  orchestrator now depends on `AgentRunnerPort`; the classical callback
  API is retained via `.service` so v0.1 callers are unaffected.
- **Test count** — 283 → 723 tests. `validate.sh` keeps all four checks
  green. Per-file 500-line cap is enforced globally with only
  `apps/cli/src/setup.ts` remaining on the grandfather list (723 lines,
  tracked for split).

### Security

- `POST /api/intervention` is **localhost-only** by default. The handler
  rejects requests whose `Host` header is not `localhost` / `127.0.0.1`
  / `[::1]`. Opt-in remote access requires
  `SYMPHONY_ALLOW_REMOTE_INTERVENTION=1`; a signed-session-token version
  is planned for v0.3.
- `append_prompt` text is sanitised (`sanitizeIssueBody`) and capped at
  10,000 characters before reaching the agent session.
- Webhook receivers now perform constant-time HMAC comparison for both
  Linear and GitHub adapters.

## [0.1.0] - 2026-04

Initial release. Linear tracker + Claude / Codex / Gemini agents + retry
queue + DAG scheduler + multi-repo routing + score-based routing + team
dashboard beta.
