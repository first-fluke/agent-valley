# AGENTS.md — Symphony Dev Template

> Common entry point for all agents (Claude Code, Codex, Gemini, Antigravity).
> Detailed content lives in `docs/`. This file serves as an index only.

---

## 1. Install & Build

**Install the harness (new or existing projects):**

```bash
# New project (after cloning)
./scripts/install.sh

# Existing project (run from project root)
curl -fsSL https://raw.githubusercontent.com/first-fluke/agent-valley/main/scripts/install.sh | bash
```

The install script auto-detects project state and branches into new/existing mode.

**Post-install validation:**

```bash
./scripts/harness/validate.sh
```

**New project full build/test:**

```bash
./scripts/dev.sh
```

**Configuration files:**

| File | Scope | Description |
|---|---|---|
| `~/.config/agent-valley/settings.yaml` | Global (user) | API key, agent defaults, team dashboard |
| `valley.yaml` | Project | Team config, workspace root, workflow states, prompt, routing |

Run `av setup` to create both files interactively. See `valley.example.yaml` for format reference.

> On missing config, error messages must include the missing key path and which file to set it in.

---

## 2. Architecture Overview

Symphony SPEC — 7 components:

| # | Component | Responsibility |
|---|---|---|
| 1 | **Workflow Loader** | Prompt template rendering + input sanitization |
| 2 | **Config Layer** | YAML config loader (settings.yaml + valley.yaml) + Zod validation |
| 3 | **Issue Tracker Client** | Linear / GitHub webhook parsing + signature verification + startup sync |
| 4 | **Orchestrator** | Webhook event handler, state machine, retry queue, sole in-memory state authority. v0.2+ split into `OrchestratorCore` / `IssueLifecycle` / `WebhookRouter` / `InterventionBus` |
| 5 | **Workspace Manager** | Per-issue isolated directory + git worktree lifecycle. v0.2+ split into `worktree-lifecycle` / `delivery-strategy` / `safety-net` |
| 6 | **Agent Runner** | `AgentRunnerPort` abstraction (claude/gemini/codex via native protocols) + live intervention `RunHandle` |
| 7 | **Observability** | Structured logs (JSON) + optional OTel traces + optional Prometheus metrics |

**Domain port layer (v0.2+):** Application code speaks to four domain
ports — `IssueTracker`, `WebhookReceiver<TEvent>`, `WorkspaceGateway`,
`AgentRunnerPort` — so adapters (Linear / GitHub / filesystem+git /
spawn) are swappable without touching orchestration logic. Interfaces
live in `packages/core/src/domain/ports/`.

**Dependency direction:** see `docs/architecture/LAYERS.md`

**Boundary principle:** Symphony is a scheduler/runner. It manages lifecycle state transitions (Todo→InProgress→Done/Cancelled). Agents focus on business logic (code writing, PR creation).

**Component details:** see `docs/specs/`

---

## 3. Security

- **Least privilege:** Grant agents only the minimum permissions needed for the task.
- **Prompt injection defense:** `WORKFLOW.md` is trusted. Issue body is always suspect — validate at the entry point.
- **Network egress control:** Agents must not make direct external network calls. All external calls go through approved adapters.
- **Secret management:** Never include API keys or tokens in code, logs, or commits. `valley.yaml` and `settings.yaml` are registered in `.gitignore`.
- **Intervention surface (v0.2+):** `POST /api/intervention` is localhost-only by default — the handler rejects requests whose `Host` header is not `localhost` / `127.0.0.1` / `[::1]`. Remote access is explicitly opt-in via `SYMPHONY_ALLOW_REMOTE_INTERVENTION=1` and is planned to land in v0.3 behind a signed session token.
- **Audit logging:** Record all agent actions as structured logs.

**Details:** `docs/harness/SAFETY.md`

---

## 4. Git Workflows

- **Merge philosophy:** Short-lived PRs. Waiting is expensive, fixing is cheap.
- **CI = mergeable:** Merge when `.github/workflows/ci.yml` passes. Human review focuses on architecture gatekeeping only.
- **Worktree isolation:** Work in isolated git worktrees per issue. See `./scripts/dev.sh`.
- **PR checklist:** See `.github/PULL_REQUEST_TEMPLATE.md`.
- **Branch strategy:** Short-lived branches based on issue identifier. Delete immediately after merge.

---

## 5. Conventions

**Golden Principles:**

1. **Shared utilities first** — Never implement the same logic twice. Reusable code belongs in shared modules.
2. **Validate at the boundary** — External inputs (issue body, API responses, env vars) are validated only at system entry points. Trusted internally.
3. **Team standard tools** — Enforce stack-specific linters. Agents use the same tools. (See `docs/architecture/enforcement/`)

**Error message principle:** Include fix instructions, not just warnings. An agent must be able to self-correct from the error message alone.

**Coverage threshold (v0.2+):** `lines >= 80%`, `branches >= 70%`, `functions >= 80%`, `statements >= 80%`. Enforced by `validate.sh` Check 5/5 via `bun run test:coverage` (vitest v8 provider). Thresholds live in `vitest.config.ts:coverage.thresholds`. Local opt-out for fast iteration: `SKIP_COVERAGE=1`; CI must not skip.

**Code style:** Stack-specific details in `docs/stacks/`.

**Architecture constraints:** `docs/architecture/CONSTRAINTS.md`.

---

## 6. Metrics

Metrics for measuring agent throughput and harness efficiency:

| Metric | Description |
|---|---|
| **Time to PR** | Time from issue assignment to PR creation |
| **CI pass rate** | Percentage of PRs that pass CI on the first run |
| **Review time per PR** | Average time a human reviewer spends per PR |
| **Doc freshness** | Last update of this file (`AGENTS.md`). Review if >30 days stale. |

**Feedback loop:** If agents repeatedly fail in a pattern, update this file. Details: `docs/harness/FEEDBACK-LOOPS.md`

---

## Reference Doc Map

```
docs/
├── architecture/
│   ├── LAYERS.md          ← Dependency direction rules
│   ├── CONSTRAINTS.md     ← Forbidden pattern list
│   └── enforcement/       ← Stack-specific linter config examples
├── specs/                 ← Symphony 7-component interfaces + domain models
├── stacks/                ← Stack-specific quickstart guides (TypeScript / Python / Go)
└── harness/
    ├── SAFETY.md          ← Security details
    ├── LEGIBILITY.md      ← Worktree isolation, DevTools Protocol
    ├── FEEDBACK-LOOPS.md  ← Feedback loop design + measurement metrics
    └── ENTROPY.md         ← AI slop prevention, GC patterns
```

<!-- OMA:START — managed by oh-my-agent. Do not edit this block manually. -->

# oh-my-agent

## Architecture

- **SSOT**: `.agents/` directory (do not modify directly)
- **Response language**: Follows `language` in `.agents/oma-config.yaml`
- **Skills**: `.agents/skills/` (domain specialists)
- **Workflows**: `.agents/workflows/` (multi-step orchestration)
- **Subagents**: Same-vendor native dispatch via Codex custom agents in `.codex/agents/{name}.toml`; cross-vendor fallback via `oma agent:spawn`

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
