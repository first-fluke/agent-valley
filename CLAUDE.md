# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Claude Code Sub-agents

When working on this project, use these specialized sub-agents:
- @.claude/agents/symphony-architect.md — for architecture decisions, SPEC design
- @.claude/agents/symphony-implementer.md — for feature implementation
- @.claude/agents/symphony-reviewer.md — for code review

## What This Project Is

Globe CRM — a polyglot monorepo for a geographic-aware CRM platform. The project combines:

- **Symphony orchestrator** (TypeScript + Bun) — receives Linear webhook events and dispatches work to AI agents in isolated git worktrees
- **Web dashboard** (Next.js) — admin UI
- **API** (Python FastAPI) — backend services (planned)
- **Mobile** (Flutter) — mobile app (planned)
- **Infrastructure** (Terraform) — cloud provisioning (planned)

## Commands

```bash
# Tool version management
mise install                    # Install all pinned tool versions

# Backing services
docker compose up -d            # Start PostgreSQL, Redis, MinIO
docker compose down             # Stop all services

# Symphony orchestrator
bun run src/main.ts             # Run the orchestrator server

# Dashboard
cd dashboard && bun dev         # Run Next.js dev server

# Lint & format (root-level)
bunx @biomejs/biome check .     # Lint + format check
bunx @biomejs/biome check --write .  # Auto-fix

# Validate architecture (secret detection, layer violations, forbidden patterns)
./scripts/harness/validate.sh

# Bootstrap dev environment
./scripts/dev.sh

# Type-check (no emit — Bun handles transpilation)
tsc --noEmit
```

No unit test runner is configured yet. CI runs `validate.sh` only. Tests are expected alongside implementation per AGENTS.md conventions.

## Architecture (as implemented)

**Clean architecture layers — dependencies point downward only:**

```
Presentation   src/server/          HTTP endpoints (/webhook, /status, /health)
     ↓
Application    src/orchestrator/    Orchestrator (state machine), AgentRunnerService, RetryQueue
     ↓
Domain         src/domain/          Pure types: Issue, Workspace, RunAttempt, OrchestratorRuntimeState
     ↓
Infrastructure src/tracker/         Linear GraphQL client + webhook HMAC + state mutations + comments
               src/workspace/       Git worktree lifecycle
               src/sessions/        AgentSession implementations (Claude, Codex, Gemini)
               src/config/          Zod-based config validation + WORKFLOW.md parser
               src/observability/   Structured JSON/text logger
```

**Key invariant:** Orchestrator is the single authority for in-memory runtime state (`OrchestratorRuntimeState`). No other component mutates it.

**Key boundary:** Symphony is a scheduler/runner. It manages lifecycle state transitions (Todo→InProgress→Done/Cancelled) and posts work summaries. Agents focus on business logic (code writing, PR creation).

## Monorepo Structure

```
globe-crm/
├── apps/
│   ├── api/              ← Python FastAPI backend (planned)
│   ├── web/              ← Next.js frontend (currently dashboard/)
│   └── mobile/           ← Flutter mobile app (planned)
├── packages/             ← Shared TypeScript packages (planned)
├── infra/                ← Terraform IaC (planned)
├── src/                  ← Symphony orchestrator
├── docker-compose.yml    ← PostgreSQL+PostGIS, Redis, MinIO
├── .mise.toml            ← Node 22, Python 3.12, Flutter 3, Terraform 1.x
└── biome.json            ← Root lint/format config
```

## Backing Services

| Service | Port | Credentials |
|---|---|---|
| PostgreSQL + PostGIS | 5432 | `globe:globe` / db: `globe_crm` |
| Redis | 6379 | no auth |
| MinIO (S3) | 9000 (API) / 9001 (Console) | `minioadmin:minioadmin` |

## Agent Session Plugin System

`src/sessions/agent-session.ts` defines the `AgentSession` interface. Each agent type extends `BaseSession` (shared event emitter + process management):

- `ClaudeSession` — spawns a new process per `execute()` (stateless)
- `CodexSession` — persistent JSON-RPC connection via stdio
- `GeminiSession` — dual-mode: ACP persistent server or one-shot fallback

`SessionFactory` uses a registry pattern for runtime lookup by agent type string.

## Config & Workflow

- **Config:** Zod schema in `src/config/config.ts` validates all env vars at startup. Fails fast with actionable error messages including the variable name and where to fix it.
- **WORKFLOW.md:** YAML front matter (`---` delimited) defines tracker/workspace/agent/server config. Prompt template body follows, with `{{issue.identifier}}`, `{{issue.title}}`, `{{issue.description}}`, `{{workspace_path}}` template variables. Supports `$VAR` env var substitution.

## Architecture Constraints

Defined in `docs/architecture/CONSTRAINTS.md`. Key rules:
- Domain layer must have zero imports from other layers
- No business logic in routers or infrastructure
- Max 500 lines per file
- No shared mutable state outside Orchestrator
- Error messages must be actionable (include variable name + fix instructions)

## Reference Docs

- `docs/specs/` — Interface specs for each of the 7 Symphony components
- `docs/architecture/LAYERS.md` — Dependency direction rules
- `docs/architecture/CONSTRAINTS.md` — Forbidden patterns
- `docs/stacks/typescript.md` — TypeScript/Bun-specific patterns
- `docs/harness/SAFETY.md` — Security rules (prompt injection, secret management, network egress)
