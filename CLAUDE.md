# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Claude Code Sub-agents

When working on this project, use these specialized sub-agents:
- @.claude/agents/symphony-architect.md — for architecture decisions, SPEC design
- @.claude/agents/symphony-implementer.md — for feature implementation
- @.claude/agents/symphony-reviewer.md — for code review

## What This Project Is

Symphony Dev Template — an agent orchestration platform that receives Linear webhook events and dispatches work to AI agents (Claude Code, Codex, Antigravity, Cursor, Grok, Kimi, opencode) in isolated git worktrees. Implemented in **TypeScript + Bun**.

## Commands

```bash
# Start dashboard + orchestrator + ngrok
bun av dev

# Validate architecture (secret detection, layer violations, forbidden patterns)
./scripts/harness/validate.sh

# Bootstrap dev environment (prerequisite checks + config validation)
./scripts/dev.sh

# Install harness into a new or existing project
./scripts/install.sh

# Garbage-collect old workspaces
./scripts/harness/gc.sh

# Type-check (no emit — Bun handles transpilation)
tsc --noEmit
```

Tests run via `bun test` (vitest). CI runs `validate.sh` + tests.

## Architecture (as implemented)

**Clean architecture layers — dependencies point downward only:**

```
Presentation   apps/dashboard/src/app/api/   Next.js Route Handlers (/api/webhook, /api/status, /api/events, /api/health)
               apps/cli/src/                 commander-based `av` CLI
     ↓
Application    packages/core/src/orchestrator/   Orchestrator (state machine), AgentRunnerService, RetryQueue, DagScheduler
     ↓
Domain         packages/core/src/domain/         Pure types: Issue, Workspace, RunAttempt, OrchestratorRuntimeState, DAG, Ledger
     ↓
Infrastructure packages/core/src/tracker/        Linear GraphQL client + webhook HMAC + state mutations + comments
               packages/core/src/workspace/      Git worktree lifecycle
               packages/core/src/sessions/       AgentSession implementations (Claude, Codex, Antigravity, Cursor, Grok, Kimi, opencode)
               packages/core/src/config/         Zod-based YAML config validation (settings.yaml + av.yaml)
               packages/core/src/observability/  Structured JSON/text logger
               packages/core/src/relay/          Supabase ledger bridge (team dashboard event sourcing)
```

**Key invariant:** Orchestrator is the single authority for in-memory runtime state (`OrchestratorRuntimeState`). No other component mutates it.

**Key boundary:** Symphony is a scheduler/runner. It manages lifecycle state transitions (Todo→InProgress→Done/Cancelled) and posts work summaries. Agents focus on business logic (code writing, PR creation).

## Agent Session Plugin System

`packages/core/src/sessions/agent-session.ts` defines the `AgentSession` interface. Each agent type extends `BaseSession` (shared event emitter + process management):

- `ClaudeSession` — spawns a new process per `execute()` (stateless)
- `CodexSession` — persistent JSON-RPC connection via stdio
- `AgySession` — Antigravity's `agy` CLI, one-shot spawn-per-`execute()` (stateless)
- `CursorSession` — `cursor-agent` CLI, streaming NDJSON, one-shot spawn-per-`execute()` (stateless)
- `GrokSession` — Grok Build's `grok` CLI, streaming NDJSON, one-shot spawn-per-`execute()` (stateless)
- `KimiSession` — Kimi Code's `kimi` CLI, streaming NDJSON, one-shot spawn-per-`execute()` (stateless)
- `OpencodeSession` — opencode's `opencode` CLI, multi-provider (75+ backends), one-shot spawn-per-`execute()` (stateless)

`SessionFactory` uses a registry pattern for runtime lookup by agent type string.

## Config

Two YAML config files, merged at startup (project wins over global):

- **Global:** `~/.config/agent-valley/settings.yaml` — user credentials (LINEAR_API_KEY), agent defaults, team dashboard settings
- **Project:** `av.yaml` — team config, workspace root, workflow states, prompt template, routing rules

Zod schema in `packages/core/src/config/yaml-loader.ts` validates the merged config. Fails fast with actionable error messages. Prompt template in `av.yaml` supports `{{issue.identifier}}`, `{{issue.title}}`, `{{issue.description}}`, `{{workspace_path}}` variables.

## Event Flow

1. Linear sends webhook → `apps/dashboard/src/app/api/webhook/route.ts` receives it
2. `packages/core/src/tracker/webhook-handler.ts` verifies HMAC-SHA256 signature
3. Orchestrator routes the event:
   - Todo → transition to In Progress via Linear API, then start agent
   - In Progress → start agent directly
   - Left In Progress → stop agent + cleanup
4. WorkspaceManager creates git worktree in `WORKSPACE_ROOT/{issue-key}`
5. AgentRunnerService spawns the appropriate agent session
6. On completion → post work summary comment + transition to Done
7. On failure → RetryQueue schedules exponential backoff; max retries exceeded → error comment + Cancelled

Startup sync: on boot, Orchestrator fetches all Todo + In Progress issues from Linear to recover state.

## Architecture Constraints

Defined in `docs/architecture/CONSTRAINTS.md`. Key rules:
- Domain layer must have zero imports from other layers
- No business logic in routers or infrastructure
- Max 500 lines per file
- No shared mutable state outside Orchestrator
- Error messages must be actionable (include variable name + fix instructions)

## Issue Creation Rules

When auditing a target repo or creating issues via `bun av issue`:
1. **Use domain-specialist skills** for audits — `/oma-frontend` for web, `/oma-backend` for API, `/oma-mobile` for mobile. Never use generic Explore agents for framework convention checks.
2. **Verify framework versions** before reporting convention issues — read `package.json`, `pubspec.yaml`, or `pyproject.toml` first. Conventions change between major versions (e.g. Next.js 16 renamed `middleware.ts` to `proxy.ts`).
3. **`--raw` issues** bypass Claude expansion — the issuer is responsible for accuracy.

## Reference Docs

- `docs/specs/` — Interface specs for each of the 7 Symphony components
- `docs/architecture/LAYERS.md` — Dependency direction rules
- `docs/architecture/CONSTRAINTS.md` — Forbidden patterns
- `docs/stacks/typescript.md` — TypeScript/Bun-specific patterns
- `docs/harness/SAFETY.md` — Security rules (prompt injection, secret management, network egress)
