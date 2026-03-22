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

**Required environment variables** (see `.env.example`, values go in `.env` only):

| Variable | Description |
|---|---|
| `LINEAR_API_KEY` | Linear Personal API key |
| `LINEAR_TEAM_ID` | Linear team identifier (e.g. `ACR`) |
| `LINEAR_TEAM_UUID` | Linear team UUID |
| `LINEAR_WEBHOOK_SECRET` | Linear webhook signing secret |
| `LINEAR_WORKFLOW_STATE_TODO` | "Todo" state ID |
| `LINEAR_WORKFLOW_STATE_IN_PROGRESS` | "In Progress" state ID |
| `LINEAR_WORKFLOW_STATE_DONE` | "Done" state ID |
| `LINEAR_WORKFLOW_STATE_CANCELLED` | "Cancelled" state ID |
| `WORKSPACE_ROOT` | Workspace root absolute path |
| `AGENT_TYPE` | Agent to use: `claude` \| `gemini` \| `codex` |
| `LOG_LEVEL` | Log level (`info` recommended) |

**Config file:** `.env` (copy from `.env.example`)

> On missing env vars, error messages must include the missing variable name and where to set it.

---

## 2. Architecture Overview

Symphony SPEC — 7 components:

| # | Component | Responsibility |
|---|---|---|
| 1 | **Workflow Loader** | Parse `WORKFLOW.md` — YAML front matter + prompt body |
| 2 | **Config Layer** | Typed config + `$VAR` env var resolution |
| 3 | **Issue Tracker Client** | Linear webhook parsing + signature verification + startup sync |
| 4 | **Orchestrator** | Webhook event handler, state machine, retry queue, sole in-memory state authority |
| 5 | **Workspace Manager** | Per-issue isolated directory + git worktree lifecycle |
| 6 | **Agent Runner** | AgentSession abstraction (claude/gemini/codex via native protocols) |
| 7 | **Observability** | Structured logs (JSON) + optional status surface |

**Dependency direction:** see `docs/architecture/LAYERS.md`

**Boundary principle:** Symphony is a scheduler/runner. It manages lifecycle state transitions (Todo→InProgress→Done/Cancelled). Agents focus on business logic (code writing, PR creation).

**Component details:** see `docs/specs/`

---

## 3. Security

- **Least privilege:** Grant agents only the minimum permissions needed for the task.
- **Prompt injection defense:** `WORKFLOW.md` is trusted. Issue body is always suspect — validate at the entry point.
- **Network egress control:** Agents must not make direct external network calls. All external calls go through approved adapters.
- **Secret management:** Never include API keys or tokens in code, logs, or commits. `.env` is registered in `.gitignore`.
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
