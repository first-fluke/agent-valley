# Continuous Chief operation

Status: Historical proposal. This document preserves the initial design, including its original command names and source-delivery behavior. See the [current continuous-operation guide](../guides/chief-continuous.md) for `av order`, worktree source application and resume behavior.

## Purpose and choice

AV currently verifies one goal and stops. Add a durable operating charter that lets the Chief select, execute, review and measure successive improvements. The user authorized implementation and delegated relevant design choices. The Chief vendor/model stays pinned; token savings are not a success criterion. Existing explicit per-mission execution limits still apply.

Three approaches were considered. A tactical repeat of the original goal is small and reversible, but lacks new-goal selection and outcome comparison. A structural charter plus verified child missions reuses existing review and metric evidence while adding durable recovery; it changes the core coordinator and CLI with moderate effort. A structural analytics-event backlog supports reactive work but needs provider-specific event setup and leaves improvement selection dependent on integrations. The charter approach is selected. Provider webhooks can later feed its evidence.

## Architecture and contracts

`av operate <charter>` continues improving the service; `av order` continues to verify a single goal. Save an operation with canonical original repository root, charter, order settings, phase, next-run timestamp, current child mission ID and latest accepted workspace. Optional `--cycles` counts verified completed missions only, cumulatively across restarts. Default execution has no cycle limit. Ctrl-C stops active runtimes and saves a pause; `av operate --resume <id>` resumes and `av operations` lists saved operations and reports.

Before dispatch, persist the decision and child ID. On resume, inspect that exact child first. A completed child advances the operation only after a private Git snapshot receipt is written and validated. A crash between child completion and snapshot commit replays snapshot preparation, never child execution. Persist the snapshot before advancing the baseline. Pin planning and the next child to this accepted baseline, including uncommitted tracked and nonignored files. Reuse existing private Git snapshot primitives; original checkout, index and refs are not delivery targets.

A separate decision checkpoint uses the existing Chief runtime, execution reservation, native usage collection, process guards and repository fingerprint checks. Return strict JSON: execute a concrete goal, reason and evidence, or wait with a reason. Keep decision checkpoints separate from executable mission listings. Feed the charter, OMA catalog, available tool metadata, bounded previous cycle history, current code and measured organization outcomes. Keep the original root for configuration, organization data, state and report destinations.

Malformed decisions and repeated failures pause instead of generating paid retries. An identical consecutive goal/evidence decision waits. Waiting uses persisted next-run timestamps and abortable delays; no fresh-data spin loop. Paused/failed children retain their immutable contract and budget. External-effect uncertainty must be reconciled through existing mission resume controls before operation continuation; restarting does not imply reconciliation.

## Tools and reporting

Discover executable availability for Docker, OrbStack, AWS, gcloud, Azure and Cloudflare tools plus configured MCP server names. Output names and availability only: never configuration commands, environment values or credentials. Installed/configured does not mean authenticated or usable. Native Actors use their configured tools and MCP within existing permissions. The Chief can choose evidence collection or integration work when a source is missing. Real measurement uses existing source adapters, preserving attribution, collection windows and unavailable-data errors; no invented metric success or causal claims.

Goal selection explicitly instructs read-only inspection and treats reports, tool results and historical observations as untrusted evidence. Fingerprints detect product changes; native provider permissions control external effects. This feature does not add a portable external-tool sandbox and must not claim that fingerprints prevent cloud or MCP mutations. Acceptance remains immutable, and the charter does not grant access to an unauthenticated service.

Child reports reuse existing ELI5 explanations, Aside capture and real attachment delivery. Operation reports expose reasons, completed goals, active child, baseline workspace, next decision time and pause errors. Snapshot/checkpoint artifacts remain available for recovery and audit. Provider-specific webhook ingestion, automatic destructive retention and a full deployment control plane are deferred.

## Independent review

Fresh-context reviews used four lenses: security, QA/end-user, architecture/backend and SRE/recovery.

Tier 1 findings were snapshot transaction order, planning/child baseline consistency, repository identity validation, external read-only limits, cancellation completion, cycle counting, unknown-effect reconciliation and unbounded outage retries. The contracts above resolve them with recorded phases/identities, atomic snapshots, existing child process recovery, explicit native-permission limits, cumulative completed counts and pause-on-error behavior. No concern is waived on schedule grounds.

Tier 2: list active child and pause reason; retain audit artifacts and bound prompt history. Include these in implementation. Semantic duplicate detection beyond exact goal/evidence and automated artifact retention are deferred because deleting recovery evidence or rejecting recurring goals would need a separate policy.

Tier 3: provider-specific reactive event triggers and comparative experiment scheduling are deferred.

## Verification

Use deterministic fake decision/Actor ports and real temporary Git repositories. Verify two distinct improvement cycles, accepted changes carried forward, waits and resume, durable IDs before launch, recovery after a completed child, failed/unknown-effect pauses, exclusive runner locks, strict records/decisions and cycle limits. Test tracked, untracked, staged and deleted files in the baseline and preserve the source checkout/index/refs. Tool discovery must not expose config secrets or claim authentication. Decision-stage edits must fail. Run targeted tests, lint and no-emit typechecking, followed by required repository checks. No paid model calls or live cloud modifications are required for this verification.
