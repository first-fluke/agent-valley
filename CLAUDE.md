# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Claude Code Sub-agents

When working on this project, use these specialized sub-agents:
- @.claude/agents/symphony-architect.md — for architecture decisions, SPEC design
- @.claude/agents/symphony-implementer.md — for feature implementation
- @.claude/agents/symphony-reviewer.md — for code review

## What This Project Is

Symphony Dev Template — an agent orchestration platform that receives Linear webhook events and dispatches work to AI agents (Claude Code, Codex, Gemini) in isolated git worktrees. Implemented in **TypeScript + Bun**.

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
Presentation   dashboard/src/app/api/ Next.js Route Handlers (/api/webhook, /api/status, /api/health)
     ↓
Application    src/orchestrator/    Orchestrator (state machine), AgentRunnerService, RetryQueue
     ↓
Domain         src/domain/          Pure types: Issue, Workspace, RunAttempt, OrchestratorRuntimeState
     ↓
Infrastructure src/tracker/         Linear GraphQL client + webhook HMAC + state mutations + comments
               src/workspace/       Git worktree lifecycle
               src/sessions/        AgentSession implementations (Claude, Codex, Gemini)
               src/config/          Zod-based YAML config validation (settings.yaml + valley.yaml)
               src/observability/   Structured JSON/text logger
```

**Key invariant:** Orchestrator is the single authority for in-memory runtime state (`OrchestratorRuntimeState`). No other component mutates it.

**Key boundary:** Symphony is a scheduler/runner. It manages lifecycle state transitions (Todo→InProgress→Done/Cancelled) and posts work summaries. Agents focus on business logic (code writing, PR creation).

## Agent Session Plugin System

`src/sessions/agent-session.ts` defines the `AgentSession` interface. Each agent type extends `BaseSession` (shared event emitter + process management):

- `ClaudeSession` — spawns a new process per `execute()` (stateless)
- `CodexSession` — persistent JSON-RPC connection via stdio
- `GeminiSession` — dual-mode: ACP persistent server or one-shot fallback

`SessionFactory` uses a registry pattern for runtime lookup by agent type string.

## Config

Two YAML config files, merged at startup (project wins over global):

- **Global:** `~/.config/agent-valley/settings.yaml` — user credentials (LINEAR_API_KEY), agent defaults, team dashboard settings
- **Project:** `valley.yaml` — team config, workspace root, workflow states, prompt template, routing rules

Zod schema in `src/config/yaml-loader.ts` validates the merged config. Fails fast with actionable error messages. Prompt template in `valley.yaml` supports `{{issue.identifier}}`, `{{issue.title}}`, `{{issue.description}}`, `{{workspace_path}}` variables.

## Event Flow

1. Linear sends webhook → `dashboard/src/app/api/webhook/route.ts` receives it
2. `src/tracker/webhook-handler.ts` verifies HMAC-SHA256 signature
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

<!-- OMA:START — managed by oh-my-agent. Do not edit this block manually. -->

# oh-my-agent

## Architecture

- **SSOT**: `.agents/` directory (do not modify directly)
- **Response language**: Follows `language` in `.agents/oma-config.yaml`
- **Skills**: `.agents/skills/` (domain specialists)
- **Workflows**: `.agents/workflows/` (multi-step orchestration)
- **Subagents**: Same-vendor native dispatch via Claude Code Agent tool with `.claude/agents/{name}.md`; cross-vendor fallback via `oma agent:spawn`

## Per-Agent Dispatch

1. Resolve `target_vendor_for_agent` from `.agents/oma-config.yaml`.
2. If `target_vendor_for_agent === current_runtime_vendor`, use the runtime's native subagent path.
3. If vendors differ, or native subagents are unavailable, use `oma agent:spawn` for that agent only.

## Workflows

Execute by naming the workflow in your prompt. Keywords are auto-detected via hooks.

| Workflow | File | Description |
|----------|------|-------------|
| orchestrate | `orchestrate.md` | Parallel subagents + Review Loop |
| work | `work.md` | Step-by-step with remediation loop |
| ultrawork | `ultrawork.md` | 5-Phase Gate Loop (11 reviews) |
| plan | `plan.md` | PM task breakdown |
| brainstorm | `brainstorm.md` | Design-first ideation |
| review | `review.md` | QA audit |
| debug | `debug.md` | Root cause + minimal fix |
| scm | `scm.md` | SCM + Git operations + Conventional Commits |

To execute: read and follow `.agents/workflows/{name}.md` step by step.

## Auto-Detection

Hooks: `UserPromptSubmit` (keyword detection), `PreToolUse`, `Stop` (persistent mode)
Keywords defined in `.agents/hooks/core/triggers.json` (multi-language).
Persistent workflows (orchestrate, ultrawork, work) block termination until complete.
Deactivate: say "workflow done".

## Rules

1. **Do not modify `.agents/` files** — SSOT protection
2. Workflows execute via keyword detection or explicit naming — never self-initiated
3. Response language follows `.agents/oma-config.yaml`

## Project Rules

Read the relevant file from `.agents/rules/` when working on matching code.

| Rule | File | Scope |
|------|------|-------|
| backend | `.agents/rules/backend.md` | on request |
| commit | `.agents/rules/commit.md` | on request |
| database | `.agents/rules/database.md` | **/*.{sql,prisma} |
| debug | `.agents/rules/debug.md` | on request |
| design | `.agents/rules/design.md` | on request |
| dev-workflow | `.agents/rules/dev-workflow.md` | on request |
| frontend | `.agents/rules/frontend.md` | **/*.{tsx,jsx,css,scss} |
| i18n-guide | `.agents/rules/i18n-guide.md` | always |
| infrastructure | `.agents/rules/infrastructure.md` | **/*.{tf,tfvars,hcl} |
| mobile | `.agents/rules/mobile.md` | **/*.{dart,swift,kt} |
| quality | `.agents/rules/quality.md` | on request |

<!-- OMA:END -->
