# LEGIBILITY.md — Application Legibility Principles

> Application Legibility is the ability of an agent to observe and interpret system state on its own during execution.
> If an agent cannot see what it is doing, it cannot make correct decisions.

---

## 1. Per-Worktree Isolation Boot

### Why Isolate

When agents process multiple issues concurrently, sharing the same file system causes conflicts.
Worktree isolation structurally prevents file system collisions between agents.

### Pattern

```bash
git worktree add {WORKSPACE_ROOT}/{key} -b issue/{key}
```

- `{key}`: value derived from `issue.identifier` with characters outside `[A-Za-z0-9._-]` replaced by `_`
- Each worktree has an independent working directory
- An agent does not write files outside its assigned worktree path

### Lifecycle

| Phase            | Action                                               |
| ---------------- | ---------------------------------------------------- |
| Issue assignment | Execute `git worktree add`                           |
| Agent execution  | Work only within the assigned worktree path          |
| PR merge         | Remove worktree + delete branch                      |
| 30 days unused   | GC agent auto-cleans (see `docs/harness/ENTROPY.md`) |

### Implementation Reference

`./scripts/dev.sh` — one-command dev environment boot (includes worktree creation)

---

## 2. Chrome DevTools Protocol (CDP)

### Why CDP

When agents perform tasks that involve browser manipulation (frontend bug fixes, UI verification),
if the agent cannot see the rendering result, it only repeats trial and error.
CDP gives agents the eyes of the browser.

### Configuration

```bash
# Enable debugging port when launching the browser
chromium --remote-debugging-port=9222
```

### What Agents Can Do with CDP

| Capability             | Usage Example                                        |
| ---------------------- | ---------------------------------------------------- |
| Screenshot capture     | Inspect rendering results and decide the next action |
| Network logs           | Verify API requests/responses                        |
| DOM queries            | Check element existence                              |
| Console log collection | Detect runtime errors                                |

### When It Is Useful

- When a frontend agent is debugging a rendering bug
- When a UI agent is verifying interactions such as form submission or button clicks
- When an agent directly performs visual regression tests

### Caution

CDP is a temporary debugging tool. Production agents do not need to keep a browser open at all times.
Disable it for tasks that do not require browser access.

---

## 3. Ephemeral Observability Stack

### Purpose

It must be possible to see what is happening in real time during agent execution.
If you cannot tell whether an agent is stuck, looping, or progressing normally,
you cannot determine the right moment for human intervention.

### Components

| Component           | Form                 | Purpose                  |
| ------------------- | -------------------- | ------------------------ |
| Structured logs     | JSON (stdout)        | Agent action timeline    |
| HTTP status surface | Optional, local port | Real-time status queries |

### Structured Log Format

```json
{
  "ts": "2026-03-16T10:00:00Z",
  "level": "info",
  "event": "agent.action",
  "issue": "ACR-42",
  "workspace": "/workspaces/ACR-42",
  "action": "file.write",
  "path": "src/api/users.py"
}
```

All agent actions are recorded in this format. Detailed specification: `docs/specs/observability.md`

### HTTP Status Surface (Optional)

A lightweight HTTP endpoint for querying agent status from a browser during local development.

```
GET /status       -> List of currently running agents
GET /status/{key} -> Processing status for a specific issue
```

Disable or add authentication when deploying to production.

---

## References

- `AGENTS.md` Section Architecture Overview — Observability component overview
- `docs/specs/observability.md` — structured log specification + metric collection points
- `docs/harness/ENTROPY.md` — worktree GC pattern
- `docs/harness/SAFETY.md` — audit log requirements
