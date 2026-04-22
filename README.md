# Agent Valley

Linear- or GitHub-driven agent orchestration platform. Register an issue in your tracker, and AI agents (Claude, Codex, Gemini) automatically develop it in isolated git worktrees — in parallel.

> Read this in: [한국어](./README.ko.md)

```
Linear Issue (Todo)
  → Webhook → Orchestrator → Git Worktree → Agent Session
  → Completion → Merge/PR → Done
```

**Key principle:** Agent Valley is a scheduler/runner. It manages lifecycle state transitions (Todo → In Progress → Done/Cancelled) and posts work summaries. Agents focus on business logic (code writing, PR creation).

Built with **TypeScript + Bun**. Supports **Claude Code, Codex, and Gemini CLI** out of the box via the AgentSession plugin system — add custom agents by implementing a single interface.

---

## How It Works

1. Create an issue on Linear (or `bun av issue "description"`)
2. Linear sends a webhook to the dashboard
3. Orchestrator verifies HMAC signature, transitions the issue to In Progress
4. DAG scheduler checks dependencies — blocked issues wait until blockers complete
5. WorkspaceManager creates an isolated git worktree in `WORKSPACE_ROOT`
6. AgentRunnerService spawns the agent (Claude / Codex / Gemini)
7. On completion: auto-merge to main (or create PR), post summary to Linear, transition to Done
8. On failure: exponential backoff retry (60s × 2^n, max 3 attempts), then cancel with error comment
9. Slot refill: completed agents free up capacity, next waiting issue starts automatically

Multiple issues run in parallel up to `MAX_PARALLEL` (auto-detected from hardware).

---

## Quick Start

```bash
# Clone
git clone https://github.com/first-fluke/agent-valley.git
cd agent-valley
bun install

# Interactive setup wizard
bun av setup

# Or copy template and fill in manually
cp valley.example.yaml valley.yaml

# Start (dashboard + orchestrator + ngrok tunnel)
bun av dev
```

Copy the ngrok URL printed to the console into Linear webhook settings → `{url}/api/webhook`.

---

## CLI

```bash
bun av setup              # Interactive setup wizard
bun av dev                # Start in foreground (file watching + auto-restart)
bun av up                 # Start as background daemon
bun av down               # Stop background daemon
bun av status             # Query orchestrator status
bun av top                # Live agent status monitor
bun av logs               # Tail dashboard logs (-n for line count)
bun av login              # Login to team (Supabase auth)
bun av logout             # Logout from team
bun av invite             # Copy team config to clipboard
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
  type: claude          # Default agent: claude / codex / gemini
  timeout: 3600
  max_retries: 3

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
#   token: ghp_xxx
#   owner: my-org
#   repo: my-repo
#   webhook_secret: whsec_xxx

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

# Score-Based Routing (optional)
scoring:
  model: haiku
  routes:
    easy:  { min: 1, max: 3, agent: gemini }
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
│           ├── sessions/       Agent plugins: Claude, Codex, Gemini
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

| Agent | Protocol | Mode |
|---|---|---|
| **Claude** | NDJSON streaming (`claude --print --output-format stream-json`) | Stateless — new process per execute |
| **Codex** | JSON-RPC 2.0 over stdio (`codex app-server --listen stdio://`) | Persistent connection |
| **Gemini** | ACP persistent / one-shot JSON fallback | Dual-mode with feature detection |

Extensible via `SessionFactory.registerSession()` — implement the `AgentSession` interface to add custom agents.

---

## Dashboard

PixiJS-rendered office scene showing real-time agent status:

- **Agent characters** at desks with issue identifier bubbles
- **Office visualization** — desks scale to `MAX_PARALLEL`, coffee machine, server rack, etc.
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
| `/api/health` | GET | Health check (503 if orchestrator not initialized) |
| `/api/intervention` | POST | Live agent intervention (pause / resume / append_prompt / abort). Localhost-only in v0.2 |
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
- `append_prompt` — native on Codex / Gemini ACP; cancel + respawn on stateless Claude
- `abort` — force-kill the session

Commands flow through `InterventionBus` (FIFO per attempt, last-writer-wins). The HTTP surface is localhost-only in v0.2; remote access lands in v0.3 behind a signed session token.

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
bun test                        # Run tests (vitest, 283 tests)
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
- **Intervention surface** — `POST /api/intervention` is localhost-only (checks `Host` header) unless `SYMPHONY_ALLOW_REMOTE_INTERVENTION=1`
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
