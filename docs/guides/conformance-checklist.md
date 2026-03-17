# Conformance Checklist

Before declaring implementation complete, verify all items below.

---

## Symphony SPEC §18.1 (Orchestrator)

- [ ] Single Orchestrator instance per process
- [ ] Webhook-driven event handling (no polling)
- [ ] Webhook signature verification (HMAC-SHA256)
- [ ] Startup sync via one-time Linear API call
- [ ] Concurrent execution limit enforced (`config.concurrency.maxParallel`)
- [ ] No duplicate `RunAttempt` for same issue
- [ ] Retry queue is in-memory only (not persisted)
- [ ] Restart recovery via startup sync
- [ ] Timeout enforcement (`config.agent.timeout_seconds`)
- [ ] Max retry count respected (`config.agent.max_retries`)
- [ ] Orchestrator does NOT write Linear issue state
- [ ] All events logged in structured format
- [ ] Graceful shutdown on SIGTERM
- [ ] `WORKFLOW.md` change detection with rolling restart

---

## Architecture

- [ ] No framework/ORM imports in domain layer
- [ ] No business logic in Router/Handler
- [ ] No hardcoded secrets
- [ ] Issue body sanitized before prompt insertion
- [ ] No file > 500 lines
- [ ] No mutable state outside Orchestrator
- [ ] All errors include fix instructions

---

## Security

- [ ] `.env` is gitignored
- [ ] No secrets in logs or commits
- [ ] Agents operate only within their workspace path
- [ ] Prompt injection defense implemented

---

## Tooling

- [ ] `./scripts/harness/validate.sh` passes with 0 violations
- [ ] Stack linter passes (dependency-cruiser / import-linter / golangci-lint)
- [ ] Tests pass with coverage > threshold
- [ ] Pre-commit hooks installed

---

## Quick Reference

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
