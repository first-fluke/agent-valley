# ENTROPY.md — Entropy Management

> Agents produce code fast but do not clean up after themselves.
> Left unchecked, duplicate code, dead branches, and unreferenced utilities accumulate.
> Entropy management is the structural prevention of this accumulation.

---

## 1. "AI Slop" Prevention Strategy

### Symptoms

- The same logic is implemented across multiple files
- Unused imports, unreferenced utility functions
- Different naming conventions in each file
- New wrappers created while ignoring existing abstractions

### Cause

This happens when an agent adds code while only seeing the immediate task unit, without full codebase context.
If the agent does not know about an existing shared utility, it creates a new one.

### Prevention

**1. AGENTS.md Conventions Section — Providing Context**

Specify the rules an agent must read before starting any task.
Include shared utility locations, naming conventions, and forbidden patterns.
(See `AGENTS.md` Section Conventions — Golden Principles)

**2. Enforced Linting — Mechanical Blocking**

If conventions exist only as documentation, agents will miss them. Mechanize them as lint rules.

```bash
# Run in pre-commit hook
./scripts/harness/validate.sh
```

Examples of what lint catches:
- Duplicate imports
- Unused symbols (unused exports)
- Dependency layer violations (per `docs/architecture/LAYERS.md`)

**3. Location Guidance in Error Messages**

```
Error: 'formatDate' function already exists in 'src/utils/date.ts'.
Do not create a new one — import and use the existing function.
```

(See `docs/harness/FEEDBACK-LOOPS.md` — Error message design principles)

---

## 2. Background GC Agent Pattern

### Why GC Is Needed

Agents do not clean up worktrees, branches, or temporary files after completing their tasks.
When these accumulate, new agents may reference stale context, causing contamination.

### Execution Frequency

Runs automatically once per week (`.github/workflows/harness-gc.yml`)

Manual execution:
```bash
./scripts/harness/gc.sh
```

### GC Targets

| Target                 | Criteria                                  | Action                              |
| ---------------------- | ----------------------------------------- | ----------------------------------- |
| Completed worktrees    | Remaining after PR merge                  | `git worktree remove`               |
| Unused branches        | Last commit older than 30 days            | `git branch -d` (including remote)  |
| Unreferenced utilities | No import references + older than 30 days | Flag and request human confirmation |

### Caution

GC follows a soft-delete principle. It does not delete immediately — it flags first, then
deletes on the next GC cycle after confirmation. Unreferenced utilities are never auto-deleted;
human confirmation is always requested.

---

## 3. Harness Maturity Levels

The agent harness is built incrementally. Do not aim for L3 from the start.

### Level 1 — Basic (Starting point for new projects)

Goal: An environment where agents can operate within minimal rules

- [ ] `AGENTS.md` exists and contains all 6 standard sections
- [ ] Pre-commit hook: lint + basic checks (`.github/.pre-commit-config.yaml`)
- [ ] Basic tests: unit tests + coverage threshold

### Level 2 — Team (When agents operate at team scale)

Goal: CI mechanically guarantees architectural invariants

- [ ] CI architecture constraint verification (`scripts/harness/validate.sh`)
  - Dependency layer linter runs automatically
  - Forbidden pattern detection
- [ ] AI PR-specific review checklist (`.github/PULL_REQUEST_TEMPLATE.md`)
  - Architecture layer violation check
  - Whether `AGENTS.md` update is needed
  - AI-generated code review items
- [ ] Dependency layer linter CI automation

### Level 3 — Production (Enterprise scale)

Goal: Full tracking of agent behavior with automatic alerts

- [ ] Custom middleware: agent behavior tracking + anomaly pattern detection
- [ ] Full observability stack: OpenTelemetry (OTEL) integration
- [ ] Performance monitoring + automatic alerts (when metric thresholds are exceeded)

---

## References

- `AGENTS.md` Section Conventions — Golden Principles, team standard tools
- `docs/architecture/CONSTRAINTS.md` — forbidden rules list
- `docs/harness/FEEDBACK-LOOPS.md` — violation pattern to CONSTRAINTS.md update cycle
- `docs/harness/LEGIBILITY.md` — worktree lifecycle
- `scripts/harness/gc.sh` — GC script
- `.github/workflows/harness-gc.yml` — GC automation workflow
