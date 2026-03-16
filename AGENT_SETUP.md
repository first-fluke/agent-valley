# AGENT_SETUP.md — AI Agent Onboarding Guide

> **This document is written for AI agents.**
> If you are an AI agent (Claude Code, Codex, Gemini, Antigravity, Cursor, Amp, or any other coding assistant), read this file carefully before doing any work in this repository. It contains everything you need to understand the project, set up an implementation, and follow conventions correctly.

---

## 0. How to Use This Document

**If you were given this file by a developer asking you to set up the project:**
→ Start at [Section 1: Project Overview](#1-project-overview) and follow the steps sequentially.

**If you are already working inside this repository and need context:**
→ Read [Section 2: Primary Context Files](#2-primary-context-files) first, then jump to the section relevant to your task.

**If you are asked to implement a specific Symphony component:**
→ Skip to [Section 5: Implementing Symphony Components](#5-implementing-symphony-components).

**If you need to understand the architecture rules before writing code:**
→ Read [Section 4: Architecture Rules](#4-architecture-rules) carefully. Violating these rules will cause CI failures.

---

## 1. Project Overview

This repository is a **stack-agnostic AI coding agent orchestration harness** based on the [OpenAI Symphony SPEC](https://github.com/openai/symphony/blob/main/SPEC.md).

### What it does

1. **Polls Linear** for issues in "In Progress" state
2. **Creates an isolated git worktree** per issue at `{WORKSPACE_ROOT}/{issue-key}/`
3. **Spawns a coding agent** (`codex serve`) in that worktree with a rendered prompt from `WORKFLOW.md`
4. **Monitors the agent**, handles timeouts and retries
5. **The agent** reads `AGENTS.md`, implements the issue, commits, opens a PR
6. **CI validates** the PR → human reviews architecture → merge → worktree GC

### What Symphony does NOT do

- Symphony **never writes to Linear**. Agents write to Linear (status changes, comments).
- Symphony is a **scheduler and runner only**.

### Key files to read before anything else

| File | Why |
|---|---|
| `AGENTS.md` | Project conventions, golden principles, component overview — **read this first** |
| `WORKFLOW.md` | The YAML config + agent prompt template |
| `.env.example` | All required environment variables |
| `docs/architecture/LAYERS.md` | Dependency direction rules — violating this breaks CI |
| `docs/architecture/CONSTRAINTS.md` | 7 forbidden patterns with code examples |

---

## 2. Primary Context Files

### AGENTS.md — The Source of Truth

`AGENTS.md` is the single source of truth for all agents. It contains:
- Build & test commands
- Architecture overview (7 Symphony components)
- Security rules
- Git workflow
- Conventions and golden principles
- Metrics

**Always read `AGENTS.md` before starting any task in this repository.**

### WORKFLOW.md — The Contract File

`WORKFLOW.md` has two parts separated by `---`:
1. **YAML front matter**: Orchestrator configuration (tracker, workspace, agent, concurrency)
2. **Prompt body**: The template rendered and sent to the agent for each issue

The `$VAR` syntax in YAML references environment variables. The `{{variable}}` syntax in the prompt body is filled at runtime.

### docs/ — Detailed Specifications

```
docs/specs/           ← Component-by-component interface specs (read before implementing)
docs/architecture/    ← Layer rules + forbidden patterns + stack-specific enforcement
docs/stacks/          ← Quick-start guides per language (TypeScript / Python / Go)
docs/harness/         ← Security, observability, entropy management, feedback loops
```

---

## 3. Environment Setup

### Step 0: Install the harness

**New project** (cloned this repo directly):

Everything is already in place. Just reset the git history and start your own:

```bash
rm -rf .git
git init
git add -A
git commit -m "chore: init from composer"
```

No need to run `install.sh` — the full scaffold is already present.

**Existing project** (adding the harness to a project you already have):

```bash
cd your-existing-project
curl -fsSL https://raw.githubusercontent.com/first-fluke/composer/main/scripts/install.sh | bash
```

The installer auto-detects existing project files (`package.json`, `pyproject.toml`, `go.mod`) and installs only the harness layer:

| Item | Action |
|---|---|
| `.agents/`, `.claude/`, `docs/` | Copied |
| `scripts/harness/gc.sh`, `validate.sh` | Copied |
| `WORKFLOW.md`, `.env.example` | Copied |
| `AGENTS.md` | Appended (Symphony section added) |
| `CLAUDE.md` | `@AGENTS.md` line injected if missing |
| `.gitignore` | Missing entries appended |
| `src/`, `scripts/dev.sh` | **Skipped** |
| `.github/` workflows | **Optional** — asked interactively |

The installer is idempotent — safe to run multiple times.

### Step 1: Copy and fill `.env`

```bash
cp .env.example .env
```

Edit `.env` with real values:

```bash
# Linear issue tracker
LINEAR_API_KEY=lin_api_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx    # Linear Personal API Key
LINEAR_TEAM_ID=ACR                                          # Your team identifier
LINEAR_TEAM_UUID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx      # Team UUID
LINEAR_WORKFLOW_STATE_IN_PROGRESS=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
LINEAR_WORKFLOW_STATE_DONE=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
LINEAR_WORKFLOW_STATE_CANCELLED=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# Symphony orchestrator
WORKSPACE_ROOT=/absolute/path/to/workspaces    # MUST be an absolute path
LOG_LEVEL=info                                  # debug | info | warn | error
LOG_FORMAT=json                                 # json | text

# Optional
# CODEX_SERVER_URL=http://localhost:3000
# OTEL_ENDPOINT=http://localhost:4317
```

**Important:** `.env` is gitignored. Never commit it.

### Step 2: Find Linear UUIDs

```bash
# Team UUID
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query":"{ teams { nodes { id key name } } }"}' | jq .

# Workflow state UUIDs
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query":"{ workflowStates { nodes { id name type } } }"}' | jq .
```

Look for states with `type: "started"` (In Progress), `type: "completed"` (Done), `type: "cancelled"` (Cancelled).

### Step 3: Validate environment

```bash
./scripts/harness/validate.sh
```

This script:
- Checks all required environment variables are set
- Validates `WORKSPACE_ROOT` is an absolute path
- Scans for hardcoded secrets and architecture violations
- Confirms harness scripts are executable

For new projects, you can also run the full bootstrap (lint + tests):
```bash
./scripts/dev.sh
```

**If validation fails:** Each error includes the exact fix instruction. For example:
```
FAIL: WORKSPACE_ROOT is not set.
  → Add WORKSPACE_ROOT=/absolute/path to .env
  → Copy from .env.example if unsure
```

---

## 4. Architecture Rules

**These rules are enforced automatically.** `./scripts/harness/validate.sh` runs before every commit (pre-commit hook) and in CI. Violations will block the PR.

### Clean Architecture Layers

```
Presentation   ← CLI, HTTP handler. No business logic.
    |
    ↓ (only downward)
Application    ← Orchestrator, WorkspaceManager. Coordinates via interfaces.
    |
    ↓
Domain         ← Issue, Workspace, RunAttempt. Pure rules. ZERO external dependencies.
    |
    ↓
Infrastructure ← LinearApiClient, FileSystem, Git, Logger. Adapters only.
```

**Dependency arrows point downward only.** An import from Domain to Infrastructure is a violation. An import from Application to Presentation is a violation.

Full rules: `docs/architecture/LAYERS.md`

### 7 Forbidden Patterns

Read `docs/architecture/CONSTRAINTS.md` for complete examples. Summary:

| # | Rule |
|---|---|
| 1 | No framework/ORM/SDK imports in Domain layer |
| 2 | No business logic in Router/Handler (Presentation layer) |
| 3 | No hardcoded secrets — use env vars only |
| 4 | Issue body is untrusted — sanitize before inserting into prompts |
| 5 | No file exceeding 500 lines |
| 6 | No shared mutable state outside Orchestrator |
| 7 | Error messages must include fix instructions, not just describe the problem |

### Architecture Enforcement Tools

| Stack | Tool | Config location |
|---|---|---|
| TypeScript | dependency-cruiser | `docs/architecture/enforcement/typescript.md` |
| Python | import-linter + Ruff | `docs/architecture/enforcement/python.md` |
| Go | golangci-lint + go vet | `docs/architecture/enforcement/go.md` |

---

## 5. Implementing Symphony Components

Before implementing any component:
1. Read `docs/specs/{component}.md` — the interface contract
2. Read `docs/specs/domain-models.md` — shared domain models
3. Read `docs/architecture/LAYERS.md` — which layer the component belongs in
4. Check `docs/architecture/CONSTRAINTS.md` — forbidden patterns to avoid

### Component Index

| Component | Layer | Spec file | Key responsibility |
|---|---|---|---|
| Workflow Loader | Infrastructure | `docs/specs/workflow-loader.md` | Parse `WORKFLOW.md` YAML + body, resolve `$VAR` |
| Config Layer | Infrastructure | `docs/specs/config-layer.md` | Build typed `Config` object, fail-fast on missing vars |
| Issue Tracker Client | Infrastructure | `docs/specs/tracker-client.md` | Linear GraphQL, fetch in-progress issues |
| Orchestrator | Application | `docs/specs/orchestrator.md` | Polling loop, state machine, retry queue |
| Workspace Manager | Application | `docs/specs/workspace-manager.md` | `git worktree` per issue, lifecycle hooks |
| Agent Runner | Application | `docs/specs/agent-runner.md` | Spawn `codex serve`, JSON-RPC, timeout |
| Observability | Infrastructure | `docs/specs/observability.md` | Structured JSON logs, event catalog |

### Domain Models (shared by all components)

```
Issue {
  id          : string   // Linear UUID
  identifier  : string   // e.g., "ACR-42"
  title       : string
  description : string   // UNTRUSTED — always sanitize before use in prompts
  status      : { id, name, type }
  team        : { id, key }
  url         : string
}

Workspace {
  issueId   : string
  path      : string   // {WORKSPACE_ROOT}/{key}/
  key       : string   // identifier with [^A-Za-z0-9._-] → _
  status    : "idle" | "running" | "done" | "failed"
  createdAt : ISO8601
}

RunAttempt {
  id            : string    // UUID v4
  issueId       : string
  workspacePath : string
  startedAt     : ISO8601
  finishedAt    : ISO8601 | null
  exitCode      : number | null   // 0 = success
  agentOutput   : string | null   // max 10KB, truncated
}
```

Full definitions: `docs/specs/domain-models.md`

### Orchestrator Polling Loop

```
while isRunning:
  1. TrackerClient.fetchInProgressIssues()
  2. For each issue:
     a. If no workspace → WorkspaceManager.create(issue)
     b. If already in activeWorkspaces → skip (no duplicate runs)
  3. Check concurrency limit (config.concurrency.maxParallel)
  4. Process retry queue (RetryEntry where nextRetryAt <= now)
  5. AgentRunner.spawn(issue, workspace) for runnable issues
  6. Handle completed RunAttempts (exitCode == 0 → done, != 0 → retry queue)
  7. Wait config.pollIntervalSec, repeat
```

Full spec including restart recovery: `docs/specs/orchestrator.md`

### Workspace Key Derivation

```typescript
// TypeScript
const key = issue.identifier.replace(/[^A-Za-z0-9._-]/g, '_');
const path = `${config.workspace.rootPath}/${key}`;
```

```python
# Python
import re
key = re.sub(r'[^A-Za-z0-9._-]', '_', issue.identifier)
path = f"{config.workspace.root_path}/{key}"
```

```go
// Go
import "regexp"
re := regexp.MustCompile(`[^A-Za-z0-9._-]`)
key := re.ReplaceAllString(issue.Identifier, "_")
path := filepath.Join(config.Workspace.RootPath, key)
```

### Prompt Injection Defense

**This is mandatory.** Issue descriptions are external input and must be sanitized before inserting into agent prompts.

```typescript
function sanitizeIssueBody(description: string): string {
  // 1. Length limit
  const truncated = description.slice(0, 8000);
  // 2. Remove injection patterns
  const sanitized = truncated
    .replace(/ignore previous instructions/gi, '[REDACTED]')
    .replace(/you are now/gi, '[REDACTED]')
    .replace(/system:/gi, '[REDACTED]');
  // 3. Wrap in boundary markers
  return `--- ISSUE DESCRIPTION START ---\n${sanitized}\n--- ISSUE DESCRIPTION END ---`;
}
```

---

## 6. Stack-Specific Setup

Choose ONE stack and follow the guide. The `src/` directory is currently empty.

### TypeScript Setup

Full guide: `docs/stacks/typescript.md`

```bash
mkdir src && cd src
npm init -y
npm install --save-dev typescript ts-node @types/node
npm install express zod dotenv
npm install --save-dev jest ts-jest @types/jest
npm install --save-dev eslint prettier typescript-eslint
npm install --save-dev dependency-cruiser
npx tsc --init
```

**Required `tsconfig.json` settings:**
```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true
  }
}
```

Config validation with Zod:
```typescript
import { z } from "zod";
const envSchema = z.object({
  LINEAR_API_KEY: z.string().min(1, {
    message: "LINEAR_API_KEY is not set.\n  Fix: Add LINEAR_API_KEY=lin_api_xxx to .env"
  }),
  WORKSPACE_ROOT: z.string().refine(v => v.startsWith("/"), {
    message: "WORKSPACE_ROOT must be an absolute path.\n  Fix: Set WORKSPACE_ROOT=/absolute/path in .env"
  }),
  // ... other vars
});
const parsed = envSchema.safeParse(process.env);
if (!parsed.success) { console.error(parsed.error.issues); process.exit(1); }
export const config = parsed.data;
```

Architecture linter: `docs/architecture/enforcement/typescript.md`

### Python Setup

Full guide: `docs/stacks/python.md`

```bash
# Requires uv (https://astral.sh/uv)
uv init src && cd src
uv python pin 3.12
uv add fastapi uvicorn pydantic-settings httpx
uv add --dev pytest pytest-asyncio ruff import-linter
uv sync
```

Config validation with Pydantic:
```python
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env")
    linear_api_key: str
    workspace_root: str

    @field_validator("workspace_root")
    @classmethod
    def must_be_absolute(cls, v: str) -> str:
        if not v.startswith("/"):
            raise ValueError(
                f"WORKSPACE_ROOT must be an absolute path.\n"
                f"  Current: {v!r}\n"
                f"  Fix: Set WORKSPACE_ROOT=/absolute/path in .env"
            )
        return v

try:
    settings = Settings()
except Exception as e:
    import sys; print(f"Config error:\n{e}", file=sys.stderr); sys.exit(1)
```

Architecture linter: `docs/architecture/enforcement/python.md`

### Go Setup

Full guide: `docs/stacks/go.md`

```bash
mkdir src && cd src
go mod init github.com/your-org/my-symphony
go get github.com/labstack/echo/v4
go get github.com/joho/godotenv
go get github.com/stretchr/testify
go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
```

Config validation:
```go
import (
    "fmt"
    "os"
    "strings"
    "github.com/joho/godotenv"
)

func loadConfig() (*Config, error) {
    _ = godotenv.Load()
    key := os.Getenv("LINEAR_API_KEY")
    if key == "" {
        return nil, fmt.Errorf("LINEAR_API_KEY is not set.\n  Fix: Add LINEAR_API_KEY=lin_api_xxx to .env")
    }
    root := os.Getenv("WORKSPACE_ROOT")
    if !strings.HasPrefix(root, "/") {
        return nil, fmt.Errorf("WORKSPACE_ROOT must be an absolute path.\n  Current: %q\n  Fix: Set WORKSPACE_ROOT=/absolute/path in .env", root)
    }
    // ...
    return &Config{LinearAPIKey: key, WorkspaceRoot: root}, nil
}
```

Architecture linter: `docs/architecture/enforcement/go.md`

---

## 7. Project Conventions

### Golden Principles (from AGENTS.md)

1. **Shared utilities first** — Never implement the same logic twice. Reusable code belongs in shared modules.
2. **Validate at the boundary** — External inputs (issue body, API responses, env vars) are validated only at system entry points. Internal objects are trusted.
3. **Team standard tools** — Stack-specific linters are mandatory. Agents use the same tools as humans.

### Error Message Rule

Every error message must include a fix instruction. An agent reading an error message must be able to fix the problem without further context.

```
# Bad
Error: Missing environment variable

# Good
Error: LINEAR_API_KEY is not set.
  → Add it to .env file (copy from .env.example)
  → Location: /your/project/.env
  → Format: LINEAR_API_KEY=lin_api_xxxxxxxx
```

### Structured Logging

All log output must be JSON (when `LOG_FORMAT=json`) with these required fields:

```json
{
  "ts": "2026-03-16T10:00:00.000Z",
  "level": "info",
  "event": "runner.spawn",
  "component": "AgentRunner",
  "issue": "ACR-42",
  "workspace": "/workspaces/ACR-42",
  "attempt_id": "a1b2c3",
  "pid": 12345
}
```

Never log: `LINEAR_API_KEY` value, full `Issue.description`, full `agentOutput`, environment dumps.

Full event catalog: `docs/specs/observability.md`

### File Size Limit

No single file exceeds 500 lines. If a file grows beyond this, split by responsibility:

```
# Too large
orchestrator.ts  (1200 lines)

# Correct
orchestrator/
├── poller.ts        ← polling loop
├── stateMachine.ts  ← state transitions
├── retryQueue.ts    ← retry scheduling
└── index.ts         ← public interface
```

---

## 8. Git Workflow

### Branch Strategy

```bash
git checkout -b issue/ACR-42
# work...
git commit -m "feat(ACR-42): implement config layer with typed validation"
git push origin issue/ACR-42
# open PR
```

Branch name: `issue/{IDENTIFIER}` where `{IDENTIFIER}` is the Linear issue key.

### Before Every Commit

```bash
./scripts/harness/validate.sh
```

This checks:
- Secret patterns (API keys, tokens)
- Dangerous shell commands
- Architecture layer violations (domain importing from infrastructure)

### Workspace Isolation

Each agent runs in its own `git worktree`. You work in `{WORKSPACE_ROOT}/{key}/` only.

```bash
# Never touch other agents' workspaces
# Never write outside your workspace path
# Never modify .agents/ or .claude/ directories
```

### Commit Message Format

```
type(scope): short description

# Types: feat | fix | refactor | test | docs | chore
# Scope: the component or module being changed
# Example:
feat(orchestrator): add exponential backoff retry queue
fix(config): validate WORKSPACE_ROOT is absolute path
test(agent-runner): add timeout scenario to test matrix
```

---

## 9. Available Agent Skills

These skills are available for Claude Code (via `/skill-name`) or any agent that reads `.agents/skills/`:

### Symphony Skills

```
symphony-scaffold      — Full project scaffold for chosen stack (TypeScript/Python/Go)
symphony-component     — Implement a single Symphony component
symphony-conformance   — Audit implementation against Symphony SPEC
harness-gc             — Guided worktree garbage collection
```

### Development Skills

```
backend-agent    — Stack-agnostic API backend implementation
frontend-agent   — React/Next.js frontend implementation
db-agent         — Database schema and migration
debug-agent      — Systematic debugging
qa-agent         — Test writing and quality assurance
pm-agent         — Feature planning and issue breakdown
commit           — Conventional commit message generation
brainstorm       — Architecture brainstorming
```

### Claude Code Sub-agents

```
symphony-architect    — Architecture decisions and SPEC interpretation
symphony-implementer  — Feature implementation with architecture compliance
symphony-reviewer     — Code review using PR template as framework
```

---

## 10. Conformance Checklist

Before declaring implementation complete, verify:

### Symphony SPEC §18.1 (Orchestrator)

- [ ] Single Orchestrator instance per process
- [ ] Polling interval is configurable
- [ ] Concurrent execution limit enforced (`config.concurrency.maxParallel`)
- [ ] No duplicate `RunAttempt` for same issue
- [ ] Retry queue is in-memory only (not persisted)
- [ ] Restart recovery via Linear re-poll
- [ ] Timeout enforcement (`config.agent.timeout_seconds`)
- [ ] Max retry count respected (`config.agent.max_retries`)
- [ ] Orchestrator does NOT write Linear issue state
- [ ] All events logged in structured format
- [ ] Graceful shutdown on SIGTERM
- [ ] `WORKFLOW.md` change detection with rolling restart

### Architecture

- [ ] No framework/ORM imports in domain layer
- [ ] No business logic in Router/Handler
- [ ] No hardcoded secrets
- [ ] Issue body sanitized before prompt insertion
- [ ] No file > 500 lines
- [ ] No mutable state outside Orchestrator
- [ ] All errors include fix instructions

### Security

- [ ] `.env` is gitignored
- [ ] No secrets in logs or commits
- [ ] Agents operate only within their workspace path
- [ ] Prompt injection defense implemented

### Tooling

- [ ] `./scripts/harness/validate.sh` passes with 0 violations
- [ ] Stack linter passes (dependency-cruiser / import-linter / golangci-lint)
- [ ] Tests pass with coverage > threshold
- [ ] Pre-commit hooks installed

---

## 11. Common Mistakes to Avoid

| Mistake | Correct approach |
|---|---|
| Importing `LinearClient` in a Domain model | Define an interface in `domain/ports/`, implement it in `infrastructure/` |
| Writing `if retryCount > 3` in a Router | Move the decision to Application layer (Orchestrator) |
| `console.log("API Key:", config.linearApiKey)` | Never log secrets. Use `"linear_connected": true` instead |
| `prompt = f"Fix this: {issue.description}"` | Use `sanitizeIssueBody(issue.description)` first |
| `orchestrator.ts` grows to 900 lines | Split into `poller.ts`, `stateMachine.ts`, `retryQueue.ts` |
| `ERROR: config invalid` | `ERROR: WORKSPACE_ROOT must be absolute.\n  Fix: Set WORKSPACE_ROOT=/path in .env` |
| Writing to `/workspaces/OTHER-42/` | Only write within your assigned workspace path |
| `git push --force origin main` | Never force push to main. Use PRs only. |
| Redefining `Issue` type in workspace-manager | Import from `domain/issue` — one definition, no duplication |

---

## 12. Quick Reference

```bash
# Bootstrap (first time)
cp .env.example .env && vim .env
chmod +x scripts/dev.sh scripts/harness/*.sh
./scripts/dev.sh

# Validate before commit
./scripts/harness/validate.sh

# Scaffold a Symphony implementation (interactive)
# Claude Code:
/symphony-scaffold
# Any agent:
# Read .agents/skills/symphony-scaffold/SKILL.md and follow the steps

# Run GC
./scripts/harness/gc.sh

# CI jobs (same commands used in .github/workflows/ci.yml)
./scripts/harness/validate.sh      # Step 1: validate
# [stack-specific test command]    # Step 2: test

# Check all docs cross-references
# (Use symphony-conformance skill or run manually)
```

---

## 13. File Modification Rules

When working in this repository, follow these rules for each file type:

| File | Rule |
|---|---|
| `AGENTS.md` | Update when adding new conventions, shared utilities, or forbidden patterns. Keep under ~150 lines. |
| `WORKFLOW.md` | Edit only the YAML config section for tuning. Do not change prompt template without team review. |
| `docs/specs/*.md` | These are interface contracts. Only update if the interface changes. |
| `docs/architecture/CONSTRAINTS.md` | Add new rules here when a repeated violation is discovered. Always include code examples. |
| `src/` | Your implementation lives here. Follow the stack guide. |
| `.agents/skills/` | Do not modify existing skills. Add new ones if you need new capabilities. |
| `.claude/agents/` | Do not modify sub-agent system prompts without understanding the impact on all tasks they handle. |
| `.env` | Never commit. Values are local only. |
| `.env.example` | Keep in sync with `.env` key names. Never put real values here. |

---

*This document is generated from the project source. For the latest version, always re-read from the repository root.*
