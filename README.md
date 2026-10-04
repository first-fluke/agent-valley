# Agent Valley

Run AI actors in isolated Git worktrees. Use Linear/GitHub issues for queued, parallel work, or give a local Chief Director a goal to plan, delegate, review, and verify.

> Read this in: [한국어](./README.ko.md)

```
Linear Issue (Todo)
  → Webhook → Orchestrator → Git Worktree → Actor Session
  → Completion → Merge/PR → Done
```

Tracker mode manages lifecycle transitions (Todo → In Progress → Done/Cancelled) and delivers verified changes. Chief Director orders keep a local plan, task reviews, and verification results for a goal.

Built with **TypeScript + Bun**. Supports **Claude Code, Codex, Qwen Code, Antigravity, Cursor, Grok, Kimi, and OpenCode** through the AgentSession interface.

See the [operability audit](./docs/reports/operability-audit-2026-10-03.md) for tested user journeys, fixes, and remaining limits.

---

## How It Works

1. Create an issue on Linear or GitHub (or `bun av issue "description"`)
2. The tracker sends a webhook to the dashboard
3. Orchestrator verifies HMAC signature, transitions the issue to In Progress
4. DAG scheduler checks dependencies — blocked issues wait until blockers complete
5. WorkspaceManager creates an isolated git worktree under `workspace.root`
6. AgentRunnerService starts the configured actor CLI
7. After verification: merge and push or create a PR, post a tracker summary, transition to Done
8. On failure: exponential backoff retry (60s × 2^n, max 3 attempts), then cancel with error comment
9. Slot refill: completed actors free up capacity, next waiting issue starts automatically

Multiple issues run in parallel up to `actor.max_parallel` (auto-detected from hardware).

---

## Quick Start

For agent-led setup, give a local shell-capable agent [AGENT_SETUP.md](./AGENT_SETUP.md) and the target repository. That user-facing initiating agent becomes the Chief Director, keeps its confirmed current model or saves the native default when the exact model is unknown, prepares AV/OMA/project MCP, and reports readiness without starting a mission. Delegating installation to a worker preserves the initiating session's vendor/model.

```text
/absolute/path/to/repo에 AV를 설치하고 설정해줘.
https://raw.githubusercontent.com/first-fluke/agent-valley/main/AGENT_SETUP.md 를 따라
너 자신을 Chief Director로 지정하고, 실제 완료 항목과 남은 조치를 보고해줘.
AV 설치, OMA 준비, 프로젝트 MCP 설정을 승인한다. 확인용 미션은 실행하지 마.
```

For interactive setup, run the installer from the Git repository you want actors to work on. It prepares Node.js 26.10.0 and Bun 1.4.2 when needed, installs `av`, and opens the setup wizard in an interactive terminal.

```bash
cd /absolute/path/to/repo
curl -fsSL https://raw.githubusercontent.com/first-fluke/agent-valley/main/scripts/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
```

The interactive wizard asks for the target repository and Chief Director CLI and model, and can save a trusted verification command. Agent-led setup passes the initiating agent's own runtime and model choice to `av setup --yes --json`. Setup guides provider preparation and prepares the latest OMA CLI and skills in the target repository. OMA preparation is the default. Browser sign-in and unsupported readiness checks remain concrete pending actions. The repository must have at least one commit. After setup is ready, give AV a goal with `av order "Fix the login failure"`. See the [installation, first-task and recovery guide](./docs/guides/environment-setup.md).

The Chief Director consults its Technical Director, Design Director and Marketing Director concurrently, turns the goal into success criteria and executable checks, creates 4–8 Actors including those advisers, and assigns work using available supported CLIs and installed OMA skills. Up to three independent Actors run in separate worktrees by default; reviewed changes are integrated before dependent work and final verification. Use `--parallel 1` for serial execution. The Technical Director focuses on cost, reuse, standardization and dependencies; the Design Director focuses on usability, user tests, data and retention, including a preference for dark patterns; the Marketing Director focuses on promotion, acquisition, revenue and ROI. The Chief Director reviews evidence and decides whether to repair, reassign, or replan when work fails. Each order produces a report with a plain-language explanation, checks, and remaining limits. Orders start without a tracker or daemon. `--actor` and `--model` override the saved Chief Director choice for one order; `--actors` supplies your own team. See [Chief Director orders and named actors](./docs/guides/chief-missions.md).

Without `--verify` or a saved command, the Chief Director designs fixed file, JSON, or explicit test checks bound to the original success criteria. A supplied command remains immutable. The foreground supervisor resumes child crashes and scheduled retries within saved limits; `--no-supervise` runs directly and `av missions --watch` restores eligible checkpoints after a stopped supervisor or machine. Authentication and uncertain external effects pause for inspection. `--runs`, `--duration`, `--rounds`, and the configured-price estimate limit `--cost` can be increased on resume without resetting spent budgets. Unknown cost pauses when a cost limit is set; in-flight or subscription charges are not an exact billing cap.

The Chief Director chooses how to execute and supervise the work. The user retains operational responsibility for the goal and resulting actions; the report records those actions and their verification evidence.

Orders also record actual token usage, duration and review outcomes for routing, select different available CLI types for task review, reuse repository organization evidence and enforce configured business metric targets. User-configured Stripe revenue, HTTP JSON, or file sources provide real observations; orders wait for the measurement window and unmet targets remain incomplete. Optional reporting sends actual report, screenshot and video files through replaceable Slack, Discord, Telegram, Teams, Google Chat, Mattermost or webhook adapters. Aside MCP captures the configured browser target; MP4 encoding requires ffmpeg. See [operations and report attachments](./docs/guides/chief-integrations.md).

For issue tracker automation, use an Agent Valley source checkout containing `apps/dashboard`. Run `bun av setup --mode tracker`, then `bun av doctor` and `bun av up --dev` there. Set `workspace.root` to the repository actors should work on.

The CLI attempts automatic Linear webhook registration. For manual registration use `{url}/api/webhook`; GitHub uses `{url}/api/webhook/github`.
The default tunnel provider is ngrok; set `tunnel.provider: cloudflare` in `av.yaml` to use Cloudflare Tunnel (see Configuration below).

---

## CLI

```bash
bun av setup              # Local orders: repository, Chief Director, login, OMA, verification
bun av setup --yes --actor codex --model '' --workspace /absolute/path/to/repo --json # Codex initiator, explicit user target
bun av setup --mode tracker # Linear/GitHub automation setup
bun av doctor             # Validate configuration and runtime prerequisites
bun av dev                # Start in foreground (file watching + auto-restart)
bun av up --dev           # Start background daemon without a production build
bun av up                 # Build dashboard, then start background daemon
bun av down               # Stop background daemon
bun av status             # Query orchestrator status
bun av top                # Live actor status monitor
bun av logs               # Tail dashboard logs (-n for line count)
bun av login              # Login to team (Supabase auth)
bun av logout             # Logout from team
bun av invite             # Copy team config to clipboard
bun av order --help       # Give a Chief Director a goal; --verify supplies an optional trusted command
bun av missions           # List saved local Chief Director orders
bun av missions --watch   # Resume eligible saved orders and scheduled observations
bun av reports list       # Inspect third-party delivery receipts
bun av reports retry      # Retry saved report files without running Actors
bun av integrations install # Install AV skills and MCP entries for Codex, Claude Code, Cursor, Qwen, and Antigravity
bun av mcp --workspace /absolute/project # Expose local Chief Director mission tools over stdio
```

To delegate goals from Codex, Claude Code, Cursor, Qwen Code, or Antigravity, install the project `av` skill and MCP server, then restart the client and complete its normal trust step. AV also exports [native plugin packages](./docs/guides/native-plugins.md) and supplies a [web OAuth gateway](./docs/guides/web-mcp.md) for ChatGPT and Claude. See [agent client integration](./docs/guides/agent-clients.md).

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
| `~/.config/agent-valley/settings.yaml` | Global (user) | API key, actor defaults, team dashboard |
| `av.yaml` | Project | Team config, workspace root, prompt template, routing |

Run `av setup` to create both files interactively, or follow [agent-led setup](./AGENT_SETUP.md) for an unattended installation using the initiating agent as Chief Director. See `av.example.yaml` for format reference.

Project configuration uses only `av.yaml`; setup and edits save that file. Configuration uses `actor:`. Actor profiles use `director`, `actors`, and `actorType`; existing profile fields and CLI flags remain aliases.

### Global Config (`~/.config/agent-valley/settings.yaml`)

```yaml
linear:
  api_key: lin_api_xxx

actor:
  type: claude          # Default actor: claude / codex / antigravity / cursor / grok / kimi / opencode
  timeout: 3600
  max_retries: 3
  max_parallel: 3       # Max concurrent actor runs (default: hardware-detected recommendation)

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

### Project Config (`av.yaml`)

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
      actor_type: codex
      delivery_mode: pr
      verify_command: "pytest && mypy ."   # overrides verify.command below for this route

# Verification Gate (required for code tasks). Runs before delivery and before the
# issue transitions to Done; on failure the actor retries with the captured
# output as context. Set this to commands available in the target repository.
verify:
  command: "bun run typecheck && bun run test"
  timeout_sec: 600

# Score-Based Routing (optional)
scoring:
  model: haiku
  routes:
    easy:  { min: 1, max: 3, actor: antigravity }
    medium: { min: 4, max: 7, actor: codex }
    hard:  { min: 8, max: 10, actor: claude }

# Actor Budget Caps (optional, v0.2+). Omit to disable (default).
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
│           ├── config/         YAML config loader (settings.yaml + av.yaml)
│           ├── domain/         Pure types: Issue, Workspace, RunAttempt, DAG
│           ├── orchestrator/   State machine, actor runner, retry queue, DAG scheduler
│           ├── sessions/       Actor plugins: Claude, Codex, Antigravity
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
├── AGENTS.md                 Actor instructions (shared entry point)
├── AGENT_SETUP.md            Agent-led installation and readiness procedure
├── CLAUDE.md                 Claude Code project instructions
└── av.example.yaml       Project config template
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
Infrastructure Linear + GitHub adapters, git operations, actor sessions, observability
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
| `AgentRunnerPort` | Spawn actors + expose `RunHandle` for interventions | `SpawnAgentRunnerAdapter` |

### The 7 Symphony Components

| # | Component | Responsibility | Spec |
|---|---|---|---|
| 1 | **Workflow Loader** | Prompt template rendering + input sanitization | `docs/specs/workflow-loader.md` |
| 2 | **Config Layer** | YAML config loader (settings.yaml + av.yaml) + Zod validation | `docs/specs/config-layer.md` |
| 3 | **Tracker Client** | Linear GraphQL — fetch issues, state transitions, comments, HMAC verification | `docs/specs/tracker-client.md` |
| 4 | **Orchestrator** | Webhook event handler, state machine, retry queue, DAG scheduler | `docs/specs/orchestrator.md` |
| 5 | **Workspace Manager** | Per-issue git worktree creation, merge/PR, cleanup | `docs/specs/workspace-manager.md` |
| 6 | **Actor Runner** | AgentSession abstraction, timeout enforcement, parallel execution | `docs/specs/agent-runner.md` |
| 7 | **Observability** | Structured JSON logs, system metrics, SSE status surface | `docs/specs/observability.md` |

### Actor Session Plugins

| Actor | Config value | Executable |
|---|---|---|
| Claude Code | `claude` | `claude` |
| Codex | `codex` | `codex` |
| Qwen Code | `qwen` | `qwen` |
| Antigravity | `antigravity` | `agy` |
| Cursor | `cursor` | `cursor-agent` |
| Grok | `grok` | `grok` |
| Kimi | `kimi` | `kimi` |
| OpenCode | `opencode` | `opencode` |

Extensible via `registerSession()` — implement the `AgentSession` interface to add custom actors.

---

## Dashboard

PixiJS-rendered office scene showing real-time actor status:

- **Actor characters** at desks with issue identifier bubbles
- **Office visualization** — desks scale to `actor.max_parallel`, coffee machine, server rack, etc.
- **Operations panel** — dependency blockers, retry reasons and next retry times
- **System metrics** — CPU, memory, uptime
- **SSE real-time events** — instant updates on actor.start, actor.done, actor.failed
- **Team HUD** — multi-node view (requires Supabase config)

### API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/webhook` | POST | Linear webhook receiver (HMAC-SHA256 verified) |
| `/api/webhook/github` | POST | GitHub webhook receiver (HMAC-SHA256 verified) |
| `/api/events` | GET | SSE stream for real-time dashboard updates |
| `/api/status` | GET | JSON orchestrator status snapshot |
| `/api/health` | GET | Health check (503 if the orchestrator is unavailable or stopped) |
| `/api/intervention` | POST | Live actor intervention; local by default, token-authenticated when configured |
| `/api/metrics` | GET | Prometheus-format metrics (enabled via `observability.prometheus.enabled`) |

---

## Key Features

### GitHub Issues Support (v0.2+)

Alongside Linear, GitHub Issues can drive the orchestrator. Set `tracker.kind: github` in `av.yaml` and configure the GitHub section — the domain `IssueTracker` / `WebhookReceiver` ports swap transparently. Both trackers reuse the same orchestration, retry, and delivery pipeline.

### Observability (v0.2+)

OpenTelemetry OTLP HTTP traces and Prometheus metrics ship built in but **default to off**. Enable per deployment via the `observability` section in `av.yaml`. When enabled:

- OTel spans are emitted for actor start/done/failed + webhook + DAG events.
- Prometheus metrics are served from `GET /api/metrics` (active actors, retry queue size, completion counts, failure counts, DAG cycle detections).

### Actor Budget Caps (v0.2+)

Per-issue and per-day token / cost caps prevent runaway actors. Budgets are evaluated before each spawn (`BudgetService.checkBeforeSpawn`) — when exceeded, the issue is cancelled with an actionable comment instead of spawning.

### Live Intervention (v0.2+)

Mid-run control from the dashboard via `POST /api/intervention`:

- `pause` / `resume` — Codex native (JSON-RPC)
- `append_prompt` — native on Codex / Antigravity ACP; cancel + respawn on stateless Claude
- `abort` — force-kill the session

Commands flow through `InterventionBus`. Without a configured intervention token, only local requests are accepted. Setting `SYMPHONY_INTERVENTION_TOKEN` requires a matching bearer token or browser session on every request, including local requests. The remote flag is not needed when a token is configured; setting `SYMPHONY_ALLOW_REMOTE_INTERVENTION=1` without a token rejects all requests. See [dashboard access](./docs/guides/environment-setup.md#dashboard-and-webhook-access).

### DAG Dependency Scheduling

Issues with `blocked_by` relations wait until all blockers complete. On blocker completion, the DAG scheduler cascades and dispatches unblocked issues. Cycles are detected and ignored.

### Retry Queue

Failed actor runs are retried with exponential backoff (`60s × 2^(attempt-1)`, max 3 attempts). Workspace creation failures and state transition failures are also retried. Max retries exceeded → issue cancelled with error comment.

### Safety Net

- Detects uncommitted actor work and auto-commits before delivery
- Creates safety-net draft PRs in PR mode
- Graceful shutdown on SIGTERM/SIGINT — stops all running actors
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
- **Prompt injection defense** — prompt template in `av.yaml` is trusted, issue body is always sanitized at entry point
- **Least privilege** — actors operate only within their assigned worktree
- **Secret management** — secrets in `av.yaml` and `settings.yaml` (gitignored), pre-commit secret detection
- **Fetch timeout** — 30s timeout on all tracker API calls
- **Intervention access** — local by default. A configured `SYMPHONY_INTERVENTION_TOKEN` requires authentication for local and remote requests. Browser mutations require a matching Origin; a valid bearer token also authorizes API clients. The remote flag without a token rejects all requests.
- **Sandbox execution** — every spawned actor CLI runs inside an OS-level sandbox (`sandbox-exec` on macOS, `bwrap` on Linux); spawns fail closed if no sandbox is available unless `SYMPHONY_ALLOW_UNSANDBOXED=1` is explicitly set
- **Audit logging** — all actor actions logged in structured JSON

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

If you are an AI actor reading this repository, see **[AGENTS.md](./AGENTS.md)** for detailed setup instructions, conventions, and implementation guidance.

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
