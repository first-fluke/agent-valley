# Agent Valley

Run AI agents in isolated Git worktrees. Use Linear/GitHub issues for queued, parallel work, or give a local chief a goal to plan, delegate, review, and verify.

> Read this in: [한국어](./README.ko.md)

```
Linear Issue (Todo)
  → Webhook → Orchestrator → Git Worktree → Agent Session
  → Completion → Merge/PR → Done
```

Tracker mode manages lifecycle transitions (Todo → In Progress → Done/Cancelled) and delivers verified changes. Chief orders keep a local plan, task reviews, and verification results for a goal.

Built with **TypeScript + Bun**. Supports **Claude Code, Codex, Antigravity, Cursor, Grok, Kimi, and OpenCode** through the AgentSession interface.

See the [operability audit](./docs/reports/operability-audit-2026-10-03.md) for tested user journeys, fixes, and remaining limits.

---

## How It Works

1. Create an issue on Linear or GitHub (or `bun av issue "description"`)
2. The tracker sends a webhook to the dashboard
3. Orchestrator verifies HMAC signature, transitions the issue to In Progress
4. DAG scheduler checks dependencies — blocked issues wait until blockers complete
5. WorkspaceManager creates an isolated git worktree under `workspace.root`
6. AgentRunnerService starts the configured agent CLI
7. After verification: merge and push or create a PR, post a tracker summary, transition to Done
8. On failure: exponential backoff retry (60s × 2^n, max 3 attempts), then cancel with error comment
9. Slot refill: completed agents free up capacity, next waiting issue starts automatically

Multiple issues run in parallel up to `agent.max_parallel` (auto-detected from hardware).

---

## Quick Start

```bash
# Clone
git clone https://github.com/first-fluke/agent-valley.git
cd agent-valley
bun install --frozen-lockfile

# Interactive setup wizard
bun av setup
bun av doctor

# Start dashboard + orchestrator + tunnel in the background without a production build
bun av up --dev
bun av status
```

Run from this checkout and set `workspace.root` to the existing Git repository you want agents to work on. Configure a code verification command or an analysis report path in the wizard. See the [installation, first-task and recovery guide](./docs/guides/environment-setup.md).

For a goal without a tracker, use `bun av order "Fix the login failure" --workspace /absolute/path/to/repo --verify "bun run test" --agent codex`. See [chief orders and named personas](./docs/guides/chief-missions.md) for OMA integration, research reports, and resume behavior.

The CLI attempts automatic Linear webhook registration. For manual registration use `{url}/api/webhook`; GitHub uses `{url}/api/webhook/github`.
The default tunnel provider is ngrok; set `tunnel.provider: cloudflare` in `valley.yaml` to use Cloudflare Tunnel (see Configuration below).

---

## CLI

```bash
bun av setup              # Interactive setup wizard
bun av doctor             # Validate configuration and runtime prerequisites
bun av dev                # Start in foreground (file watching + auto-restart)
bun av up --dev           # Start background daemon without a production build
bun av up                 # Build dashboard, then start background daemon
bun av down               # Stop background daemon
bun av status             # Query orchestrator status
bun av top                # Live agent status monitor
bun av logs               # Tail dashboard logs (-n for line count)
bun av login              # Login to team (Supabase auth)
bun av logout             # Logout from team
bun av invite             # Copy team config to clipboard
bun av order --help       # Give a chief a goal with a required acceptance check
bun av missions           # List saved local chief orders
```

### Creating Issues

```bash
bun av issue "fix auth bug"                        # Create issue (Claude expands description)
bun av issue "fix auth bug" --raw                  # Create without expansion
bun av issue "fix auth bug" --yes                  # Skip confirmation
bun av issue "add tests" --parent ACR-10           # Create as sub-issue
bun av issue "migrate db" --blocked-by ACR-5       # Set dependency
bun av issue "refactor auth" --breakdown           # Auto-decompose into sub-tasks
```

`--parent`, `--blocked-by`, and `--breakdown` require Linear. GitHub supports plain issue creation and `--scope`; `--raw` works with either tracker without Claude expansion.

---

## Configuration

### Config Files

Two YAML config files, merged at startup (project wins over global):

| File | Scope | Description |
|---|---|---|
| `~/.config/agent-valley/settings.yaml` | Global (user) | API key, agent defaults, team dashboard |
| `valley.yaml` | Project | Team config, workspace root, prompt template, routing |

Run `av setup` to create both files interactively. See `valley.example.yaml` for format reference.

### Global Config (`~/.config/agent-valley/settings.yaml`)

```yaml
linear:
  api_key: lin_api_xxx

agent:
  type: claude          # Default agent: claude / codex / antigravity / cursor / grok / kimi / opencode
  timeout: 3600
  max_retries: 3
  max_parallel: 3       # Max concurrent agent runs (default: hardware-detected recommendation)

logging:
  level: info           # debug / info / warn / error
  format: json          # json / text

server:
  port: 9741

# Team Dashboard (optional)
team:
  supabase_url: https://xxx.supabase.co
  supabase_anon_key: your-anon-key
  id: my-team
  display_name: my-node
```

### Project Config (`valley.yaml`)

```yaml
# Tracker selector (v0.2+). Defaults to `linear` when omitted.
tracker:
  kind: linear        # linear | github

linear:
  team_id: ACR
  team_uuid: uuid-xxx
  webhook_secret: whsec_xxx
  workflow_states:
    todo: state-uuid
    in_progress: state-uuid
    done: state-uuid
    cancelled: state-uuid

# GitHub tracker (v0.2+) — used when tracker.kind = github.
# github:
#   token_env: GITHUB_TOKEN
#   owner: my-org
#   repo: my-repo
#   webhook_secret: whsec_xxx
#   labels:
#     todo: valley:todo
#     in_progress: valley:wip
#     done: valley:done
#     cancelled: valley:cancelled

workspace:
  root: /absolute/path/to/target-repo

delivery:
  mode: merge           # merge (auto merge+push) or pr (create draft PR)

prompt: |
  You are working on {{issue.identifier}}: {{issue.title}}.
  {{issue.description}}
  Path: {{workspace_path}}

# Multi-Repo Routing (optional)
routing:
  rules:
    - label: "backend"
      workspace_root: /path/to/backend
    - label: "frontend"
      workspace_root: /path/to/frontend
      agent_type: codex
      delivery_mode: pr
      verify_command: "pytest && mypy ."   # overrides verify.command below for this route

# Verification Gate (required for code tasks). Runs before delivery and before the
# issue transitions to Done; on failure the agent retries with the captured
# output as context. Set this to commands available in the target repository.
verify:
  command: "bun run typecheck && bun run test"
  timeout_sec: 600

# Score-Based Routing (optional)
scoring:
  model: haiku
  routes:
    easy:  { min: 1, max: 3, agent: antigravity }
    medium: { min: 4, max: 7, agent: codex }
    hard:  { min: 8, max: 10, agent: claude }

# Agent Budget Caps (optional, v0.2+). Omit to disable (default).
# budget:
#   per_issue:
#     tokens: 2_000_000
#     usd: 5.00
#   per_day:
#     tokens: 20_000_000
#     usd: 50.00

# Webhook tunnel (optional, v0.3+). Omit to keep the v0.2 default (ngrok).
# tunnel:
#   provider: cloudflare   # cloudflare | ngrok | none
#   cloudflare:
#     mode: quick          # quick (random *.trycloudflare.com URL) | named
#     # name: av-webhook           # required when mode: named
#     # hostname: webhook.example.com  # UI-only, used when mode: named

# Observability (optional, v0.2+). Both default to off.
# observability:
#   otel:
#     enabled: false
#     endpoint: http://localhost:4318
#     service_name: agent-valley
#   prometheus:
#     enabled: false
#     path: /api/metrics
```

**Prompt template variables:** `{{issue.identifier}}`, `{{issue.title}}`, `{{issue.description}}`, `{{workspace_path}}`, `{{attempt.id}}`, `{{retry_count}}`

---

## Architecture

### Monorepo Structure

```
agent-valley/
├── apps/
│   ├── cli/                  @agent-valley/cli — Commander CLI (bun av)
│   └── dashboard/            agent-valley-dashboard — Next.js 16 + PixiJS
├── packages/
│   └── core/                 @agent-valley/core — Orchestration engine
│       └── src/
│           ├── config/         YAML config loader (settings.yaml + valley.yaml)
│           ├── domain/         Pure types: Issue, Workspace, RunAttempt, DAG
│           ├── orchestrator/   State machine, agent runner, retry queue, DAG scheduler
│           ├── sessions/       Agent plugins: Claude, Codex, Antigravity
│           ├── tracker/        Linear GraphQL client + webhook HMAC verification
│           ├── workspace/      Git worktree lifecycle + merge/PR
│           └── observability/  Structured JSON/text logger
├── docs/
│   ├── architecture/         LAYERS.md, CONSTRAINTS.md, enforcement/
│   ├── specs/                Symphony 7-component interface specs
│   ├── stacks/               TypeScript, Python, Go guides
│   └── harness/              SAFETY.md, LEGIBILITY.md, ENTROPY.md, FEEDBACK-LOOPS.md
├── scripts/
│   ├── dev.sh                Dev environment bootstrap
│   ├── install.sh            Harness installer (new + existing projects)
│   └── harness/
│       ├── validate.sh       Architecture validation (secrets, layer violations)
│       └── gc.sh             Worktree garbage collector
├── AGENTS.md                 Agent instructions (shared entry point)
├── CLAUDE.md                 Claude Code project instructions
└── valley.example.yaml       Project config template
```

### Clean Architecture Layers

```
Presentation   dashboard route handlers (no business logic)
     ↓
Application    Orchestrator (core / lifecycle / router / bus), AgentRunnerService
     ↓
Domain         Issue, Workspace, RunAttempt, DAG, ParsedWebhookEvent (pure types)
               + ports: IssueTracker, WebhookReceiver, WorkspaceGateway, AgentRunnerPort
     ↓
Infrastructure Linear + GitHub adapters, git operations, agent sessions, observability
```

Dependency arrows point **downward only**. See `docs/architecture/LAYERS.md`.

### Domain Port Layer

Since v0.2 the Application layer talks to the outside world through four
domain ports so adapters can be swapped without touching the orchestrator:

| Port | Purpose | Current adapters |
|---|---|---|
| `IssueTracker` | Fetch / update issues, post comments, attach labels | `LinearTrackerAdapter`, `GitHubTrackerAdapter` |
| `WebhookReceiver<TEvent>` | Verify signature + parse to `ParsedWebhookEvent` | `LinearWebhookReceiver`, `GitHubWebhookReceiver` |
| `WorkspaceGateway` | Per-issue worktree lifecycle + delivery | `FileSystemWorkspaceGateway` |
| `AgentRunnerPort` | Spawn agents + expose `RunHandle` for interventions | `SpawnAgentRunnerAdapter` |

### The 7 Symphony Components

| # | Component | Responsibility | Spec |
|---|---|---|---|
| 1 | **Workflow Loader** | Prompt template rendering + input sanitization | `docs/specs/workflow-loader.md` |
| 2 | **Config Layer** | YAML config loader (settings.yaml + valley.yaml) + Zod validation | `docs/specs/config-layer.md` |
| 3 | **Tracker Client** | Linear GraphQL — fetch issues, state transitions, comments, HMAC verification | `docs/specs/tracker-client.md` |
| 4 | **Orchestrator** | Webhook event handler, state machine, retry queue, DAG scheduler | `docs/specs/orchestrator.md` |
| 5 | **Workspace Manager** | Per-issue git worktree creation, merge/PR, cleanup | `docs/specs/workspace-manager.md` |
| 6 | **Agent Runner** | AgentSession abstraction, timeout enforcement, parallel execution | `docs/specs/agent-runner.md` |
| 7 | **Observability** | Structured JSON logs, system metrics, SSE status surface | `docs/specs/observability.md` |

### Agent Session Plugins

| Agent | Config value | Executable |
|---|---|---|
| Claude Code | `claude` | `claude` |
| Codex | `codex` | `codex` |
| Antigravity | `antigravity` | `agy` |
| Cursor | `cursor` | `cursor-agent` |
| Grok | `grok` | `grok` |
| Kimi | `kimi` | `kimi` |
| OpenCode | `opencode` | `opencode` |

Extensible via `registerSession()` — implement the `AgentSession` interface to add custom agents.

---

## Dashboard

PixiJS-rendered office scene showing real-time agent status:

- **Agent characters** at desks with issue identifier bubbles
- **Office visualization** — desks scale to `agent.max_parallel`, coffee machine, server rack, etc.
- **Operations panel** — dependency blockers, retry reasons and next retry times
- **System metrics** — CPU, memory, uptime
- **SSE real-time events** — instant updates on agent.start, agent.done, agent.failed
- **Team HUD** — multi-node view (requires Supabase config)

### API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/webhook` | POST | Linear webhook receiver (HMAC-SHA256 verified) |
| `/api/webhook/github` | POST | GitHub webhook receiver (HMAC-SHA256 verified) |
| `/api/events` | GET | SSE stream for real-time dashboard updates |
| `/api/status` | GET | JSON orchestrator status snapshot |
| `/api/health` | GET | Health check (503 if the orchestrator is unavailable or stopped) |
| `/api/intervention` | POST | Live agent intervention; local by default, token-authenticated when configured |
| `/api/metrics` | GET | Prometheus-format metrics (enabled via `observability.prometheus.enabled`) |

---

## Key Features

### GitHub Issues Support (v0.2+)

Alongside Linear, GitHub Issues can drive the orchestrator. Set `tracker.kind: github` in `valley.yaml` and configure the GitHub section — the domain `IssueTracker` / `WebhookReceiver` ports swap transparently. Both trackers reuse the same orchestration, retry, and delivery pipeline.

### Observability (v0.2+)

OpenTelemetry OTLP HTTP traces and Prometheus metrics ship built in but **default to off**. Enable per deployment via the `observability` section in `valley.yaml`. When enabled:

- OTel spans are emitted for agent start/done/failed + webhook + DAG events.
- Prometheus metrics are served from `GET /api/metrics` (active agents, retry queue size, completion counts, failure counts, DAG cycle detections).

### Agent Budget Caps (v0.2+)

Per-issue and per-day token / cost caps prevent runaway agents. Budgets are evaluated before each spawn (`BudgetService.checkBeforeSpawn`) — when exceeded, the issue is cancelled with an actionable comment instead of spawning.

### Live Intervention (v0.2+)

Mid-run control from the dashboard via `POST /api/intervention`:

- `pause` / `resume` — Codex native (JSON-RPC)
- `append_prompt` — native on Codex / Antigravity ACP; cancel + respawn on stateless Claude
- `abort` — force-kill the session

Commands flow through `InterventionBus`. Without a configured intervention token, only local requests are accepted. Setting `SYMPHONY_INTERVENTION_TOKEN` requires a matching bearer token or browser session on every request, including local requests. The remote flag is not needed when a token is configured; setting `SYMPHONY_ALLOW_REMOTE_INTERVENTION=1` without a token rejects all requests. See [dashboard access](./docs/guides/environment-setup.md#dashboard-and-webhook-access).

### DAG Dependency Scheduling

Issues with `blocked_by` relations wait until all blockers complete. On blocker completion, the DAG scheduler cascades and dispatches unblocked issues. Cycles are detected and ignored.

### Retry Queue

Failed agent runs are retried with exponential backoff (`60s × 2^(attempt-1)`, max 3 attempts). Workspace creation failures and state transition failures are also retried. Max retries exceeded → issue cancelled with error comment.

### Safety Net

- Detects uncommitted agent work and auto-commits before delivery
- Creates safety-net draft PRs in PR mode
- Graceful shutdown on SIGTERM/SIGINT — stops all running agents
- Hot reload cleanup — previous orchestrator instance stopped before new one starts

### Startup Sync

On boot, the orchestrator fetches all Todo + In Progress issues from the configured tracker and reconciles the DAG cache. Existing in-progress issues resume automatically.

---

## Development

```bash
bun run test                    # Run the Vitest suite
bun run lint                    # Lint (biome)
bun run lint:fix                # Auto-fix lint issues
./scripts/harness/validate.sh   # Architecture validation
./scripts/dev.sh                # Bootstrap dev environment
./scripts/harness/gc.sh         # Garbage-collect stale worktrees
```

### Install Harness into Existing Project

```bash
cd your-existing-project
curl -fsSL https://raw.githubusercontent.com/first-fluke/agent-valley/main/scripts/install.sh | bash
```

### CI/CD

| Workflow | Trigger | Purpose |
|---|---|---|
| `ci.yml` | Push/PR to main | `validate.sh` + tests |
| `harness-gc.yml` | Weekly (Sunday 00:00 UTC) | Stale worktree cleanup |

---

## Security

- **HMAC-SHA256** webhook signature verification on all incoming Linear and GitHub events
- **Prompt injection defense** — prompt template in `valley.yaml` is trusted, issue body is always sanitized at entry point
- **Least privilege** — agents operate only within their assigned worktree
- **Secret management** — secrets in `valley.yaml` and `settings.yaml` (gitignored), pre-commit secret detection
- **Fetch timeout** — 30s timeout on all tracker API calls
- **Intervention access** — local by default. A configured `SYMPHONY_INTERVENTION_TOKEN` requires authentication for local and remote requests. Browser mutations require a matching Origin; a valid bearer token also authorizes API clients. The remote flag without a token rejects all requests.
- **Sandbox execution** — every spawned agent CLI runs inside an OS-level sandbox (`sandbox-exec` on macOS, `bwrap` on Linux); spawns fail closed if no sandbox is available unless `SYMPHONY_ALLOW_UNSANDBOXED=1` is explicitly set
- **Audit logging** — all agent actions logged in structured JSON

Full documentation: `docs/harness/SAFETY.md`

---

## Architecture Constraints

| # | Rule | Rationale |
|---|---|---|
| 1 | No framework imports in Domain layer | Domain stays pure and testable |
| 2 | No business logic in routers | Presentation delegates to Application |
| 3 | No hardcoded secrets | Config YAML only (gitignored) |
| 4 | Issue body is untrusted | Sanitize at boundary |
| 5 | Max 500 lines per file | Readability |
| 6 | No shared mutable state outside Orchestrator | Single state authority |
| 7 | Error messages must include fix instructions | Agents self-correct from errors |

Full list with examples: `docs/architecture/CONSTRAINTS.md`

---

## For AI Agents

If you are an AI agent reading this repository, see **[AGENTS.md](./AGENTS.md)** for detailed setup instructions, conventions, and implementation guidance.

Claude Code sub-agents are available in `.claude/agents/`:
- `symphony-architect.md` — Architecture decisions, SPEC interpretation
- `symphony-implementer.md` — Feature implementation with preflight checks
- `symphony-reviewer.md` — Code review using PR template framework

---

## Metrics

| Metric | Description |
|---|---|
| **Time to PR** | Issue assigned → PR created |
| **CI pass rate** | PRs that pass CI on the first run |
| **Review time per PR** | Average human reviewer time per PR |
| **Doc freshness** | Days since `AGENTS.md` last updated (flag if > 30 days) |

---

## License

[AGPL-3.0](LICENSE)
