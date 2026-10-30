# FEEDBACK-LOOPS.md — Feedback Loop Design

> Agents generate signals for system improvement through repeated failures.
> If those signals are not captured, the same mistakes repeat indefinitely.

---

## 1. Static vs Dynamic Context

| Type        | Location                  | Update Frequency           | Role                                       |
| ----------- | ------------------------- | -------------------------- | ------------------------------------------ |
| **Static**  | `AGENTS.md`               | Manually updated by humans | Immutable rules always read on agent entry |
| **Dynamic** | Logs, metrics, CI results | Real-time                  | Basis for decisions during agent execution |

### Single Source of Truth

The repository is the single source of truth.

- Rules live in `AGENTS.md` or files under `docs/`.
- Rules that exist only in Slack messages, verbal agreements, or wikis are invisible to agents.
- All constraints agreed upon with agents must be committed to the repository.

---

## 2. Agent Failure to AGENTS.md Update Cycle

If an agent repeatedly makes the same mistake, it is a signal of missing context.

### Cycle

```
Agent failure
    |
Pattern detected (same mistake 2+ times)
    |
Add explicit prohibition rule to AGENTS.md or docs/architecture/CONSTRAINTS.md
    |
Include fix instructions in error message (so the agent can self-correct)
    |
CI detects the same violation -> automatic blocking
```

### Error Message Design Principles

Simple warnings do not enable agents to self-correct.

```
# Bad example
Error: import violation

# Good example
Error: 'orchestrator' imports from 'agent-runner' — dependency direction violation.
Allowed direction: orchestrator -> workspace-manager -> agent-runner
Fix: Instead of importing agent-runner directly from orchestrator,
     call it through the workspace-manager interface.
Reference: docs/architecture/LAYERS.md
```

An agent must be able to self-correct by reading only the error message.
(See `AGENTS.md` Section Conventions — Error message principles)

### CI Violation to CONSTRAINTS.md Update

Violations caught by CI are patterns that automated scanners missed.
Upon discovery, immediately add them to `docs/architecture/CONSTRAINTS.md` and mechanize as lint rules.

---

## 3. Metric Collection

Track agent throughput and harness efficiency numerically.
Without metrics, there is no way to know whether improvement is occurring.

| Metric                  | Collection Point                                      | Target           |
| ----------------------- | ----------------------------------------------------- | ---------------- |
| Time to PR              | `git log` (issue assignment -> PR creation timestamp) | Decreasing trend |
| CI pass rate            | GitHub Actions execution logs                         | > 90%            |
| Review time per PR      | GitHub API (review submitted timestamp)               | Decreasing trend |
| Documentation freshness | `git log AGENTS.md` latest commit date                | < 7 days         |

### Documentation Freshness Threshold

If `AGENTS.md` has not been updated for more than 7 days, the feedback loop is broken.
Interpret this as a signal that agent failure patterns are not being reflected.

Metric collection point details: `docs/specs/observability.md`

---

## 4. Feedback Loop Health Check

The feedback loop is operating normally when all of the following are satisfied.

- [ ] Last commit to `AGENTS.md` is within 7 days
- [ ] CI pass rate is above 90% over the past 2 weeks
- [ ] No pattern where an agent triggers the same lint error 3+ times consecutively
- [ ] CONSTRAINTS.md updated within 24 hours of discovering a new violation pattern

---

## References

- `AGENTS.md` Section Metrics — metric definitions
- `AGENTS.md` Section Conventions — error message principles, Golden Principles
- `docs/architecture/CONSTRAINTS.md` — forbidden rules list
- `docs/specs/observability.md` — metric collection point specification
- `docs/harness/ENTROPY.md` — harness maturity levels
