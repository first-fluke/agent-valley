# Agent Valley

Linear webhook-driven agent orchestration platform. Register an issue on Linear, and AI agents (Claude, Codex, Gemini) automatically develop it in isolated git worktrees — in parallel.

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

# Or manual configuration
cp .env.example .env
# Fill in Linear API keys, workflow state UUIDs, and WORKSPACE_ROOT

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

### Required (.env)

| Variable | Description |
|---|---|
| `LINEAR_API_KEY` | Linear Personal API key (Settings → API) |
| `LINEAR_TEAM_ID` | Team identifier (e.g. `ACR`) |
| `LINEAR_TEAM_UUID` | Team UUID (for GraphQL queries) |
| `LINEAR_WEBHOOK_SECRET` | Webhook signing secret |
| `LINEAR_WORKFLOW_STATE_TODO` | "Todo" state UUID |
| `LINEAR_WORKFLOW_STATE_IN_PROGRESS` | "In Progress" state UUID |
| `LINEAR_WORKFLOW_STATE_DONE` | "Done" state UUID |
| `LINEAR_WORKFLOW_STATE_CANCELLED` | "Cancelled" state UUID |
| `WORKSPACE_ROOT` | Absolute path to the target git repo |

**How to find Linear UUIDs:**

```bash
# List teams
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: YOUR_LINEAR_API_KEY" \
  -d '{"query":"{ teams { nodes { id key name } } }"}' | jq .

# List workflow states
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: YOUR_LINEAR_API_KEY" \
  -d '{"query":"{ workflowStates { nodes { id name type } } }"}' | jq .
```

### Optional

| Variable | Default | Description |
|---|---|---|
| `AGENT_TYPE` | `claude` | Default agent: `claude` / `codex` / `gemini` |
| `MAX_PARALLEL` | auto | Max concurrent agents (auto-detected from CPU) |
| `DELIVERY_MODE` | `merge` | `merge` (auto merge+push) or `pr` (create draft PR) |
| `SERVER_PORT` | `9741` | Dashboard HTTP port |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `LOG_FORMAT` | `json` | `json` / `text` |

### Multi-Repo Routing (optional)

Route issues to different repos based on Linear labels. First matching label wins, falls back to `WORKSPACE_ROOT`:

```bash
ROUTING_RULES='[{"label":"backend","workspaceRoot":"/path/to/backend"},{"label":"frontend","workspaceRoot":"/path/to/frontend","agentType":"codex","deliveryMode":"pr"}]'
```

### Score-Based Routing (optional)

Auto-score issue difficulty and route to different agents:

```bash
SCORING_MODEL=haiku
SCORE_ROUTING='{"easy":{"min":1,"max":3,"agent":"gemini"},"medium":{"min":4,"max":7,"agent":"codex"},"hard":{"min":8,"max":10,"agent":"claude"}}'
```

### Team Dashboard (optional)

Multi-node dashboard via Supabase real-time:

```bash
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=your-anon-key
TEAM_ID=my-team
DISPLAY_NAME=my-node
```

---

## WORKFLOW.md

The prompt template sent to agents. YAML front matter defines config (documentation-only), the body is the prompt with template variables:

```yaml
---
tracker:
  type: linear
workspace:
  root: $WORKSPACE_ROOT
agent:
  type: $AGENT_TYPE
  timeout_seconds: 3600
---

You are a software engineer working on issue {{issue.identifier}}: {{issue.title}}

## Issue Details
{{issue.description}}

## Workspace
- Path: {{workspace_path}}
- Attempt: {{attempt.id}} (retry count: {{retry_count}})

## Instructions
1. Read AGENTS.md for project conventions
2. Implement the changes described in the issue
3. Write tests
4. Commit your changes with a clear message
```

**Template variables:** `{{issue.identifier}}`, `{{issue.title}}`, `{{issue.description}}`, `{{workspace_path}}`, `{{attempt.id}}`, `{{retry_count}}`, `$VAR` (env substitution)

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
│           ├── config/         Zod config validation + WORKFLOW.md parser
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
├── WORKFLOW.md               Agent prompt template
└── .env.example              Environment variable reference
```

### Clean Architecture Layers

```
Presentation   dashboard route handlers (no business logic)
     ↓
Application    Orchestrator, AgentRunnerService (coordinate via interfaces)
     ↓
Domain         Issue, Workspace, RunAttempt, DAG (pure types, zero external deps)
     ↓
Infrastructure Linear client, git operations, agent sessions (adapters)
```

Dependency arrows point **downward only**. See `docs/architecture/LAYERS.md`.

### The 7 Symphony Components

| # | Component | Responsibility | Spec |
|---|---|---|---|
| 1 | **Workflow Loader** | Parse `WORKFLOW.md` — YAML front matter + prompt body | `docs/specs/workflow-loader.md` |
| 2 | **Config Layer** | Typed config (Zod) + `$VAR` env resolution | `docs/specs/config-layer.md` |
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
| `/api/events` | GET | SSE stream for real-time dashboard updates |
| `/api/status` | GET | JSON orchestrator status snapshot |
| `/api/health` | GET | Health check (503 if orchestrator not initialized) |

---

## Key Features

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

On boot, the orchestrator fetches all Todo + In Progress issues from Linear and reconciles the DAG cache. Existing in-progress issues resume automatically.

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

- **HMAC-SHA256** webhook signature verification on all incoming Linear events
- **Prompt injection defense** — `WORKFLOW.md` is trusted, issue body is always sanitized at entry point
- **Least privilege** — agents operate only within their assigned worktree
- **Secret management** — all secrets in `.env` only (gitignored), pre-commit secret detection
- **Fetch timeout** — 30s timeout on all Linear API calls
- **Audit logging** — all agent actions logged in structured JSON

Full documentation: `docs/harness/SAFETY.md`

---

## Architecture Constraints

| # | Rule | Rationale |
|---|---|---|
| 1 | No framework imports in Domain layer | Domain stays pure and testable |
| 2 | No business logic in routers | Presentation delegates to Application |
| 3 | No hardcoded secrets | `.env` only |
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
