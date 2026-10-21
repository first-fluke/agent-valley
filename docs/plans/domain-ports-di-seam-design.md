# Domain Ports + DI Seam — Design Doc (PR1 of 3)

- **Status:** approved (brainstorm 2026-04-21)
- **Session driver:** A + B + C + E (second tracker support, testability, readability, architecture hygiene)
- **Approach:** A (Ports-first combined, then splits) — 3 PRs total
- **This doc covers PR1 only.** PR2 (`WorkspaceManager` split) and PR3 (`Orchestrator` split) are independent follow-ups.

---

## 1. Problem

- Orchestrator directly `new`s `WorkspaceManager` and imports concrete functions from `tracker/linear-client` — violates `docs/architecture/LAYERS.md` "Application → Infrastructure through interfaces".
- Orchestrator has no unit test coverage — existing tests mock at module level and leak into real Linear API calls in `completion-handler.test.ts` (401 errors visible in `bun test` output).
- Adding a second tracker (GitHub Issues / Jira / Plane) currently means rewriting Orchestrator call sites.

## 2. Constraints and Quality Attributes

- Runtime behavior must remain identical after PR1 merge (no feature change, no performance regression).
- No backwards-compat shims — internal API.
- `OrchestratorRuntimeState` remains owned solely by `Orchestrator` (CONSTRAINTS §6).
- Domain layer stays pure (no external imports).
- Must be reviewable as a single PR of ~450 LOC.

## 3. Solution

### 3.1 Ports — `packages/core/src/domain/ports/`

Three interfaces, no `I`-prefix:

- **`IssueTracker`** — 5 methods: `fetchIssuesByStates`, `fetchIssueLabels`, `updateIssueState`, `addIssueComment`, `addIssueLabel`. All tenant args (`apiKey`, `teamId`, `teamUuid`) moved from method signatures to adapter constructor.
- **`WebhookReceiver`** — 2 methods: `verifySignature(payload, signature)`, `parseEvent(payload)`. Secret bound in adapter constructor.
- **`WorkspaceGateway`** — 9 methods mirroring current `WorkspaceManager` surface used by Application layer. Return types (`MergeResult`, `DiffStat`, `PrDraft`, `PrResult`, `UnfinishedWorkResult`) are lifted into the port file as canonical domain types.

### 3.2 Adapters

- **`LinearTrackerAdapter`** → `packages/core/src/tracker/linear-tracker-adapter.ts` — composes existing `linear-client.ts` module functions.
- **`LinearWebhookReceiver`** → `packages/core/src/tracker/linear-webhook-receiver.ts` — composes existing `webhook-handler.ts` module functions.
- **`FileSystemWorkspaceGateway`** → `packages/core/src/workspace/filesystem-workspace-gateway.ts` — composes the current `WorkspaceManager` class (no inheritance, no `implements` on the class itself — composition only, so PR2's split becomes an internal adapter change).

### 3.3 Orchestrator Constructor

```ts
constructor(
  private readonly config: Config,
  private readonly tracker: IssueTracker,
  private readonly webhook: WebhookReceiver,
  private readonly workspace: WorkspaceGateway,
)
```

`AgentRunnerService`, `RetryQueue`, `DagScheduler` remain internal (not port-injected) — they are composition helpers, not external-system adapters.

### 3.4 `completion-handler.ts` — `CompletionDeps` update

- `workspaceManager: WorkspaceManager` → `workspace: WorkspaceGateway`
- New field: `tracker: IssueTracker`
- Internal `addIssueComment(config.linearApiKey, ...)` → `deps.tracker.addIssueComment(...)` (~18 call sites).

### 3.5 Composition Root

`apps/dashboard/src/lib/bootstrap.ts` adds 4 lines:
```ts
const workspaceManager = new WorkspaceManager(config.workspaceRoot)
const tracker  = new LinearTrackerAdapter(config.linearApiKey, config.linearTeamId, config.linearTeamUuid)
const webhook  = new LinearWebhookReceiver(config.linearWebhookSecret)
const workspace = new FileSystemWorkspaceGateway(workspaceManager)
const orchestrator = new Orchestrator(config, tracker, webhook, workspace)
```

## 4. Test Strategy

### 4.1 Fakes (`packages/core/src/__tests__/fakes/`)

- `FakeIssueTracker` — records calls, returns pre-seeded issues, optional `throwOn`
- `FakeWebhookReceiver` — signature-valid toggle + pre-set `nextEvent`
- `FakeWorkspaceGateway` — in-memory workspace + attempts; configurable `mergeResult` / `diffStat`

### 4.2 New orchestrator unit tests

5 scenarios that were previously impossible without heavy `vi.mock`:

| T# | Scenario | Assertion |
|---|---|---|
| T1 | invalid HMAC | response 403, zero tracker calls |
| T2 | Todo event | `tracker.updateIssueState(_, workflowStates.inProgress)` called |
| T3 | DAG blocker | workspace not created, `state.waitingIssues.has(id)` true |
| T4 | concurrency cap | retry queue size = 1 |
| T5 | startup sync | `fetchIssuesByStates` called with both states |

### 4.3 Existing test migration

- `completion-handler.test.ts`: rename `makeMockWorkspaceManager` → `makeFakeWorkspaceGateway`, add `tracker` field to `makeDeps`, drop `as unknown as` casts. Side effect: `Linear API authentication failed` log noise disappears.
- All other tests unchanged.

## 5. Risks and Rollback

See Section 5 of brainstorm transcript. Primary risks:

1. `teamId` vs `teamUuid` confusion in adapter constructor (mitigated by explicit labeled parameters + smoke test).
2. `orchestrator.ts` size crosses grandfathered ceiling after 4-arg constructor — bump ceiling from 543 to 560 in PR1; PR3 removes the ceiling entirely.
3. PR1 alone leaves a "ports present but not yet leveraged for splits" interim state — mitigated by scheduling PR2 and PR3 as explicit follow-up issues.

Rollback: each of the 3 commits is independently revertable. Commit 1 is pure addition (dead code if reverted). Commit 2 requires reverting with Commit 3 as a unit if test coverage removal is undesired.

## 6. Out of Scope (explicit)

- `AgentRunnerService` port extraction (separate refactor)
- `scoring-service.analyzeScoreInBackground` port
- `ParsedWebhookEvent` domain promotion (requires type redesign)
- CLI Linear GraphQL deduplication (user deferred)
- `logger` as port

## 7. Follow-ups after PR1

- **PR2** — split `WorkspaceManager` (724 → ≤500 LOC) into `WorktreeLifecycle` / `GitMergeService` / `ConflictClassifier` / `PrPublisher`, keeping `FileSystemWorkspaceGateway` as the thin facade.
- **PR3** — split `Orchestrator` (≈560 → ≤400 LOC) into `WebhookRouter` / `IssueLifecycle` / `Orchestrator-core` (state + retry loop). All sub-classes depend on ports only.
- **PR4 candidates** (any order):
  - Promote `ParsedWebhookEvent` to domain (after type redesign).
  - Port `AgentRunnerService` behind `IAgentRunner`.
  - CLI Linear GraphQL dedup.

## 8. Validation

Per Approach A, PR1 is acceptance-gated on:

1. `bun test` — 410 tests green (405 existing + 5 new orchestrator tests).
2. `./scripts/harness/validate.sh` — 4/4 green (grandfather ceiling for `orchestrator.ts` bumped to 560).
3. `bun run typecheck` — zero errors.
4. Manual smoke: `bun av dev` → dashboard `/api/status` returns 200 locally.
5. `completion-handler.test.ts` run output no longer contains `Linear API authentication failed` logs.
