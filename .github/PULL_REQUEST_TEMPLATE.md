<!--
  Pull Request Template — Symphony Dev Template
  AI-aware checklist for agent-generated and human-authored PRs.

  Fill in every section. Unchecked boxes block merge for architecture items.
  For AI-generated PRs: the agent must complete this template before requesting review.
-->

## Summary

<!-- What changed and why. One paragraph max. -->

**What:** <!-- e.g. "Add Linear issue polling to Orchestrator" -->

**Why:** <!-- e.g. "ACR-42 requires the orchestrator to pick up In Progress issues" -->

**Issue:** <!-- e.g. ACR-42 or N/A -->

---

## Architecture Checklist

> Reference: `docs/architecture/CONSTRAINTS.md`, `docs/architecture/LAYERS.md`

- [ ] No layer violations — domain/ does not import from infrastructure/, presentation/, or external SDKs
- [ ] No business logic in router/handler/CLI layer (presentation delegates to application)
- [ ] No hardcoded secrets, tokens, or environment-specific values in code
- [ ] No file exceeds 500 lines — if so, split by responsibility
- [ ] No global mutable state added outside Orchestrator
- [ ] External inputs (issue body, API responses) are validated at system boundary, not deep inside

---

## AGENTS.md Update Needed?

> If this PR introduces a new pattern, convention, or shared utility, AGENTS.md must be updated
> so future agents have the context to follow it. See AGENTS.md §5 Conventions.

- [ ] No new conventions introduced — no update needed
- [ ] **New pattern added** → updated `AGENTS.md` §Conventions (describe below)
- [ ] **New shared utility added** → noted in `AGENTS.md` so agents know it exists

<!-- If updated, briefly describe what was added: -->

---

## Test Coverage

- [ ] Unit tests cover the changed logic
- [ ] Coverage threshold maintained (≥80% or project baseline)
- [ ] Edge cases tested: empty input, API errors, missing env vars
- [ ] No tests deleted without replacement

---

## AI-Generated Code Review

> Complete this section for any code produced by an AI agent (Codex, Claude, Gemini, etc.).
> Human-authored PRs may skip this section.

- [ ] Verified the agent did not duplicate existing utilities (searched codebase before accepting)
- [ ] Verified the agent did not introduce a new abstraction when an existing one covers the case
- [ ] Error messages include actionable fix instructions, not just symptom descriptions (CONSTRAINTS.md §7)
- [ ] Agent-written shell scripts use `set -e` and `set -u`
- [ ] No `TODO`/`FIXME` left by the agent without a linked issue

**Agent used:** <!-- e.g. Codex (codex serve), Claude Code, Gemini -->

**Prompt / workflow that produced this code:** <!-- e.g. WORKFLOW.md §implement-orchestrator or N/A -->

---

## Security Checklist

> Reference: `docs/harness/SAFETY.md`

- [ ] No secrets committed — `.env` is in `.gitignore`, only `.env.example` is tracked
- [ ] `scripts/harness/validate.sh` passes locally (`./scripts/harness/validate.sh`)
- [ ] External inputs (issue body, PR description, comments) are NOT directly inserted into prompts or shell commands
- [ ] No new outbound network calls added outside approved adapters (Linear API, Codex server)
- [ ] Prompt injection risk assessed — issue body treated as untrusted input throughout
- [ ] Audit log entries added for any new agent actions (file writes, API calls, state changes)

---

## Reviewer Focus Areas

<!-- Optional: tell the reviewer where to spend their time. -->

