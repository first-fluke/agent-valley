# Conventions

## Golden Principles (from AGENTS.md)

1. **Shared utilities first** — Never implement the same logic twice. Reusable code belongs in shared modules.
2. **Validate at the boundary** — External inputs (issue body, API responses, env vars) are validated only at system entry points. Internal objects are trusted.
3. **Team standard tools** — Stack-specific linters are mandatory. Agents use the same tools as humans.

---

## Error Message Rule

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

---

## Structured Logging

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

---

## File Size Limit

No single file exceeds 500 lines. If a file grows beyond this, split by responsibility:

```
# Too large
orchestrator.ts  (1200 lines)

# Correct
orchestrator/
├── webhookHandler.ts ← webhook event handling
├── stateMachine.ts   ← state transitions
├── retryQueue.ts     ← retry scheduling
└── index.ts          ← public interface
```

---

## Git Workflow

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

## Available Agent Skills

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

## Common Mistakes to Avoid

| Mistake | Correct approach |
|---|---|
| Importing `LinearClient` in a Domain model | Define an interface in `domain/ports/`, implement it in `infrastructure/` |
| Writing `if retryCount > 3` in a Router | Move the decision to Application layer (Orchestrator) |
| `console.log("API Key:", config.linearApiKey)` | Never log secrets. Use `"linear_connected": true` instead |
| `prompt = f"Fix this: {issue.description}"` | Use `sanitizeIssueBody(issue.description)` first |
| `orchestrator.ts` grows to 900 lines | Split into `webhookHandler.ts`, `stateMachine.ts`, `retryQueue.ts` |
| `ERROR: config invalid` | `ERROR: WORKSPACE_ROOT must be absolute.\n  Fix: Set WORKSPACE_ROOT=/path in .env` |
| Writing to `/workspaces/OTHER-42/` | Only write within your assigned workspace path |
| `git push --force origin main` | Never force push to main. Use PRs only. |
| Redefining `Issue` type in workspace-manager | Import from `domain/issue` — one definition, no duplication |

---

## File Modification Rules

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
