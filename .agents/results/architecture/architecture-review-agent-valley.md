# Architecture Review: agent-valley (Symphony Dev Template)

- **Date:** 2026-04-21
- **Reviewer:** oma-architecture (serena-assisted)
- **Scope:** whole repo (`packages/core`, `apps/dashboard`, `apps/cli`, `scripts/harness`, `docs/architecture`)
- **Method:** ATAM-style quality-attribute review + CBAM-style prioritized investment list
- **Artifacts scanned:** 53 TS/TSX files under `packages/core/src`, `apps/dashboard/src`, `apps/cli/src`; `AGENTS.md`, `CLAUDE.md`, `docs/architecture/LAYERS.md`, `docs/architecture/CONSTRAINTS.md`, `scripts/harness/validate.sh`, `.gitignore`

---

## 1. Scope & Current Architecture

Implemented architecture (actual, not the one described in CLAUDE.md):

```
Presentation   apps/dashboard/src/app/api/{webhook,status,events,health}/route.ts
               apps/cli/src/*.ts   ← commander entrypoints
     ↓
Application    packages/core/src/orchestrator/{orchestrator,agent-runner,retry-queue,
                                                completion-handler,dag-scheduler,
                                                scoring-service,event-emitter,helpers}.ts
     ↓
Domain         packages/core/src/domain/{models,dag,ledger}.ts            ← pure, no imports
     ↓
Infrastructure packages/core/src/tracker/*        ← Linear GraphQL + HMAC
               packages/core/src/workspace/*      ← git worktree lifecycle
               packages/core/src/sessions/*       ← Claude/Codex/Gemini adapters
               packages/core/src/config/*         ← YAML loader + Zod schemas
               packages/core/src/observability/*  ← logger
               packages/core/src/relay/*          ← Supabase ledger
```

Doc drift: `CLAUDE.md` still describes the pre-monorepo layout (`src/`, `dashboard/src/app/api`). Actual code lives under `packages/core/src` and `apps/dashboard/src`.

---

## 2. Quality Attribute Scenarios

| # | Scenario | Observed Behavior | Risk |
|---|---|---|---|
| QA-1 Security — webhook forgery | Linear posts unsigned payload; dashboard must reject | `verifyWebhookSignature` uses HMAC-SHA256 with constant-time compare; called before parse. OK. `apps/dashboard/src/app/api/webhook/route.ts:25`, `packages/core/src/tracker/webhook-handler.ts:14–29` | Low |
| QA-2 Security — status leak | Arbitrary caller hits `/api/status` or `/api/events` over ngrok tunnel | No auth, no rate limit. Returns active workspace list, issue identifiers, config flags. `apps/dashboard/src/app/api/status/route.ts`, `apps/dashboard/src/app/api/events/route.ts` | **High** |
| QA-3 Security — prompt injection via issue body | Untrusted issue body reaches agent prompt | `sanitizeIssueBody` strips `{{...}}`, `${...}`, known injection phrases at `renderPrompt` and `scoring-service`. Validated at Application boundary. OK. `packages/core/src/config/workflow-loader.ts:19–50` | Low |
| QA-4 Security — secret leakage | API keys / webhook secrets logged or committed | No `logger.*(api_key)` call sites; `valley.yaml` + `.env` in `.gitignore`; agent env whitelist in `base-session.ts:17–39`. OK | Low |
| QA-5 Reliability — orchestrator restart | Dashboard hot reload, process crash | `bootstrap.ts` stops prior orchestrator via `setOrchestrator`; singleton lives on `globalThis`. `start()` runs `ensureStartupSync` with 3× retry. Acceptable. `apps/dashboard/src/lib/bootstrap.ts`, `packages/core/src/orchestrator/orchestrator.ts:161–189` | Low |
| QA-6 Reliability — SSE handler leak | Client disconnects mid-stream | `cancel()` calls `orchestrator.off("agent.start", () => {})` — anonymous fn is a different identity, does NOT remove the handler. Slow leak of `agent.*` listeners until process restart. `apps/dashboard/src/app/api/events/route.ts:84–88` | **Medium** |
| QA-7 Modifiability — add new agent type | Community plugin (e.g. `q-dev`) | `SessionFactory` registry supports `registerSession("q-dev", …)`. OK. But `buildAgentEnv` in `base-session.ts:35` hard-codes `AGENT_ENV_KEYS` map, so new agents leak no auth env unless map is edited — not pluggable. | Medium |
| QA-8 Testability — orchestrator unit test | Swap Linear/Git with fakes | Orchestrator `new`s `WorkspaceManager` directly in constructor `orchestrator.ts:58` and imports `linear-client` functions as module bindings. No seam for injection; tests rely on process-level mocks. | Medium |
| QA-9 Cohesion — WorkspaceManager | SRP for worktree lifecycle | File is 724 LOC (violates CONSTRAINT §5) and owns worktree create + conflict classification + autoCommit + rebase-resolution heuristics + PR creation. Multiple reasons to change. `packages/core/src/workspace/workspace-manager.ts` | **High** |
| QA-10 Cohesion — Orchestrator | SRP for state machine | 543 LOC (violates CONSTRAINT §5), mixes webhook routing + startup sync + slot filling + DAG reevaluation + retry drain + API calls. `packages/core/src/orchestrator/orchestrator.ts` | Medium |
| QA-11 DRY — Linear GraphQL client | Single source of truth | `apps/cli/src/{issue,setup,breakdown}.ts` all do raw `fetch("https://api.linear.app/graphql")` instead of reusing `packages/core/src/tracker/linear-client.ts`. Golden Principle #1 violated. | Medium |
| QA-12 Observability — retry delay math | First attempt schedules a retry | `RetryQueue.add(issueId, 0, …)` computes `backoff * 2 ** (0-1) = backoff/2`. Functional but asymmetric vs. comment "Exponential backoff" and vs. usage `.add(id, 0, "concurrency limit reached")` in `tryAcceptOrQueue`. Minor. `packages/core/src/orchestrator/retry-queue.ts:42` | Low |

---

## 3. Architecture-Rule Conformance (against `docs/architecture/LAYERS.md` + `CONSTRAINTS.md`)

| Rule | Status | Evidence |
|---|---|---|
| LAYERS — Domain has no deps | **Pass** | `packages/core/src/domain/*` imports only `./models`; verified with serena pattern search |
| LAYERS — Presentation has no business logic | **Pass** | `apps/dashboard/src/app/api/webhook/route.ts` delegates to `orchestrator.handleWebhook`; CLI entries delegate to commands |
| LAYERS — Application → Infra via interface | **Fail (partial)** | `orchestrator.ts:18–20` imports concrete functions from `tracker/linear-client` and `new`s `WorkspaceManager`. There is no `IssueTrackerClient` / `WorkspaceGateway` interface in `domain/`. The DI seam the spec describes does not exist. |
| CONSTRAINT §5 — no file > 500 LOC | **Fail** | `packages/core/src/workspace/workspace-manager.ts` 724, `packages/core/src/orchestrator/orchestrator.ts` 543, `apps/cli/src/setup.ts` 723, `apps/cli/src/index.ts` 461 (close), `apps/dashboard/src/lib/canvas/sprite-generator.ts` 755 |
| CONSTRAINT §6 — no shared mutable state outside Orchestrator | **Fail (minor)** | `packages/core/src/sessions/session-factory.ts:67` exports `defaultRegistry`; `packages/core/src/observability/logger.ts:10–11` holds module-level `minLevel`/`format`. Conventional patterns, but literally forbidden by the rule as written. |
| CONSTRAINT §7 — actionable error messages | **Pass** | `yaml-loader.ts` Zod schemas consistently include `\n  Fix: …`; session-factory error includes remediation |
| `validate.sh` coverage | **Gap** | Only flags domain→infrastructure imports by path name; repo has no directory named `infrastructure`, so this check matches zero files. No 500-LOC check, no Application→concrete-Infra check, no router-business-logic check. Validator is effectively a secret scanner + shell-safety scanner. |

---

## 4. Tradeoff Points

1. **Direct infra imports vs. DI seam.** Current code optimizes for pithiness (module-level functions for Linear), at the cost of testability and the architecture spec. A DI seam pays for itself once a second tracker (GitHub Issues, Jira) is added or once orchestrator unit tests stop needing process-level mocks.
2. **500-LOC rule vs. cohesive git-workflow logic.** Worktree + conflict + auto-commit + PR creation are causally related; splitting them must preserve readable end-to-end flow. The right split is by *capability* (WorktreeLifecycle / GitMergeResolver / ConflictClassifier / PrPublisher), not by random chunking.
3. **Singleton via `globalThis` vs. explicit container.** Current approach works around Turbopack's module-instance duplication. It is pragmatic but hides the dependency graph. A proper composition root in `bootstrap.ts` returning a typed container would make DI + testability easier.

---

## 5. Risks / Non-Risks

**Risks**
- R1: Unauthenticated `/api/status` + `/api/events` on a ngrok-exposed dashboard → data leak and SSE-based resource exhaustion.
- R2: SSE `cancel()` handler-leak bug quietly grows memory/CPU cost per disconnect.
- R3: The 500-LOC rule is not enforced; CI passes even though two core files violate it. Drift will continue.
- R4: `validate.sh` creates a false sense of safety — it cannot detect the layer violations that the SPEC care about.
- R5: CLI duplicates Linear GraphQL code → divergent behavior, e.g. transport choice, error handling, retry policy.

**Non-risks**
- N1: Domain purity is healthy and worth defending.
- N2: Webhook HMAC verification is correctly implemented (constant-time compare).
- N3: Prompt injection surface area is minimized by `sanitizeIssueBody`.
- N4: Agent env forwarding is whitelisted, so rogue env vars do not reach child processes.

---

## 6. Prioritized Investment Plan (CBAM-style)

| Rank | Investment | Benefit | Cost | Risk if skipped | Sequencing |
|---|---|---|---|---|---|
| P0 | **Auth + rate limit on `/api/status` and `/api/events`** (shared secret header or host check; reject unknown origins) | Closes QA-2 data-leak vector; cheap | XS (½ day) | Data leak via public tunnel | First |
| P0 | **Fix SSE cancel() handler leak** — store handler references in closure, pass the same refs to `off()`; remove the dead arrow-fn pattern at `events/route.ts:84–88` | Stops slow listener leak | XS (≤½ day) | Long-running dashboards degrade | First |
| P1 | **Rewrite `validate.sh`** to run dependency-cruiser (already referenced in `docs/architecture/enforcement/typescript.md`) against actual layer names (`domain`, `orchestrator`, `tracker`, `workspace`, `sessions`, `config`, `observability`), add a 500-LOC line check, and a "no `fetch('https://api.linear.app')` outside `packages/core/src/tracker`" rule | Turns architecture rules from aspirational to enforceable; shrinks drift | S (1–2 days) | Drift continues; current CI is misleading | Second |
| P1 | **Introduce tracker + workspace interfaces** in `packages/core/src/domain/ports/` and inject them into `Orchestrator` constructor (`LinearTrackerAdapter implements IssueTracker`). Keeps `handleWebhook/handleIssueTodo` shape; enables fakes in tests | Realizes the LAYERS spec; unlocks meaningful orchestrator unit tests | M (2–4 days) | Orchestrator stays untestable; a second tracker is a rewrite | Second |
| P1 | **Split `WorkspaceManager`** by capability: `WorktreeLifecycle` (create/get/cleanup), `GitMergeService` (mergeAndPush/validateBranchBeforeMerge/autoResolve), `ConflictClassifier` (isHighRisk/isRegeneratable/findConflictMarkerFiles), `PrPublisher` (createDraftPR/pushBranch). Keep a thin facade for the current call-site count | Restores SRP + puts file under 500 LOC; unlocks targeted tests (current `merge-conflict.test.ts` is doing double duty) | M (2–3 days) | Change amplification continues; tests hard to scope | Third |
| P2 | **Split `Orchestrator`** into `WebhookRouter` (parse+route events), `IssueLifecycle` (`handleIssueTodo/InProgress/LeftInProgress`), and a smaller `Orchestrator` that owns runtime state + retry loop. Keep `OrchestratorRuntimeState` ownership centralized | Each file under 300 LOC; isolates the state-owning class from IO | M (2–3 days) | 500-LOC violation remains; hot code path is hard to follow | Third |
| P2 | **De-dup Linear GraphQL in CLI** — `apps/cli/src/{issue,setup,breakdown}.ts` call `@agent-valley/core/tracker/linear-client` helpers instead of their private `fetch(...)`. Add missing mutations (`issueCreate`) to the core client | Single source of truth; consistent error + transport handling; satisfies Golden Principle #1 | S (1 day) | Drift between CLI and orchestrator | Third |
| P3 | **Expose `AGENT_ENV_KEYS` via registry** — accept env-key contribution in `registerSession(type, ctor, { envKeys })` so third-party sessions pluggably forward their API key env | Unblocks pluggable agents | S (½ day) | Pluggability is only half real | Later |
| P3 | **Replace `defaultRegistry` module singleton** with a registry created in `bootstrap.ts` and passed into `AgentRunnerService`. Aligns with CONSTRAINT §6 spirit and simplifies tests | Test isolation; honest composition root | S (½ day) | Tests pollute each other via singleton | Later |
| P3 | **Sync `CLAUDE.md` to the monorepo layout** and add `apps/cli` + `apps/dashboard` + `packages/core` responsibilities. Today it describes a `src/` root that does not exist | Agents stop reading stale paths | XS | New contributors + agents get wrong paths | Later |
| P3 | **Minor:** `RetryQueue.add(id, 0, …)` — clamp `attemptCount` to ≥1 before computing backoff, or change callers to pass 1 for the first retry. Document the meaning of attemptCount=0 | Removes surprising `backoff/2` first delay | XS | Cosmetic, but the comment disagrees with the math | Later |

Effort legend: XS ≤ 4h, S ≈ 1d, M ≈ 2–4d.

---

## 7. Recommendation Summary

1. **Ship P0 today.** Both are small, and one is a live security risk the second ngrok turns on.
2. **Pay the enforcement debt (P1).** The current `validate.sh` cannot see the violations I found. Until it can, this review will be repeated. Dependency-cruiser + a tiny LOC check closes the loop.
3. **Then pay the design debt (P1 + P2).** Introduce tracker/workspace ports and split the two big Application-layer files. Do these in that order so the split work happens behind an interface that is already worth defending.
4. **Treat CLI Linear calls as a seam cleanup (P2).** One afternoon erases a class of future divergence bugs.

Artifacts intentionally NOT recommended right now:
- No new frameworks, no DI container library — TypeScript constructor injection is enough.
- No rewrite of the Linear client — it works; only its consumers need consolidating.
- No broader migration (Python/Go). The spec supports multiple stacks, but every concrete concern above is TypeScript-specific.

---

## 8. Validation Steps

- Run `bun test` + (once fixed) `./scripts/harness/validate.sh` and confirm both are green after each P-item.
- After P1 dependency-cruiser: re-run on `main` before merge to confirm no regressions; record baseline violation count.
- After P0 auth: issue a probe request from outside the allowed origin and confirm 401/403. Load-test `/api/events` with 100 concurrent SSE clients, disconnect, and confirm `orchestrator.listenerCount('agent.start')` returns to baseline (exposes QA-6 fix).
- After port extraction: add an orchestrator unit test using a `FakeIssueTracker` that triggers `handleIssueTodo` without network. Should pass without any `vi.mock` of modules.

---

## 9. Assumptions

- The dashboard is intended to be exposed via ngrok for Linear webhooks, not for general internet traffic.
- "Agents" in CONSTRAINT §6 means AI agents writing code, not programmatic instances like `AgentRunnerService`; `Map<attemptId, Session>` state inside a class instance is acceptable.
- `apps/dashboard/src/lib/canvas/*` is visual canvas code and not subject to backend layer rules, so LOC findings there are reported for awareness but not treated as architecture blockers.
- Supabase relay (`packages/core/src/relay`) is out of scope for this pass; a follow-up review should cover event-sourcing + multi-node coordination separately.
