# Changelog

All notable changes to Agent Valley are documented here. This project
follows [Semantic Versioning](https://semver.org/) and
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Commits follow
[Conventional Commits](https://www.conventionalcommits.org/).

## [Unreleased]

### Coverage gate uplift (planned)

The v0.2 coverage gate excludes files that have no unit-test seam in the
current test infrastructure. As new seams land the excludes should be
removed one at a time (never by lowering the threshold):

- `packages/core/src/relay/ledger-bridge.ts`,
  `packages/core/src/relay/node-id.ts`,
  `packages/core/src/relay/supabase-ledger-client.ts` — needs a Supabase
  test harness or an in-memory ledger fake.
- `packages/core/src/orchestrator/scoring-service.ts` — needs an LLM
  client seam (currently exercised only via `score-routing.test.ts`).
- `apps/cli/src/{issue,breakdown,invite,login,supervisor}.ts` and the
  interactive `apps/cli/src/setup/*-step.ts` files — needs a `@clack/prompts`
  fake / subprocess harness. Non-interactive helpers under `apps/cli/src/setup/`
  (mask, preview, resolve, save, yaml-build, github-api, linear-api) are
  already inside the gate.
- Dashboard UI (`apps/dashboard/**`) — needs a browser test runtime
  (Playwright / vitest-browser). Tracked for v0.3.

Target for v0.3: raise every gated module to `lines >= 85%`,
`branches >= 75%` and start removing the excludes above.

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
  Configure via the new `budget:` section in `valley.yaml`. Post-run
  token usage reported by each session adapter (`ClaudeSession` NDJSON
  `result.usage`, `CodexSession` `turn/completed.usage`, `GeminiSession`
  `usageMetadata`) is forwarded through `RunAttempt.tokenUsage` into
  `BudgetService.recordUsage()` so the per-issue and per-day counters
  accumulate automatically; sessions that cannot surface usage (e.g.
  Gemini CLI fallback) leave the hop a no-op per § 6.4 E19.
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
- **Coverage gate** — `validate.sh` Check 5/5 now runs
  `bun run test:coverage` (vitest v8 provider). Global thresholds are
  `lines >= 80%`, `branches >= 70%`, `functions >= 80%`,
  `statements >= 80%` over `packages/core/src/**` + the
  non-interactive slice of `apps/cli/src/**`. Current measurement:
  statements 88.15%, branches 76.98%, functions 89.81%, lines 90.30%.
  Interactive CLI entry points, Supabase relay plumbing, the LLM-call
  scoring service, and the React dashboard are outside the gate —
  tracked in the Unreleased section for v0.3 uplift. CI uploads
  `coverage/lcov.info` + `coverage/index.html` as an artifact. Opt-out
  for local iteration only: `SKIP_COVERAGE=1 ./scripts/harness/validate.sh`.

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
