# Chief decision ownership

Status: Accepted, 2026-10-06

## Context

The user supplies a goal after initial setup. The Chief makes execution decisions;
the user receives its decisions, evidence and outcome. Environment failures and
unavailable container observations previously bypassed Chief recovery. Continuous
operations retained a paused child but required manual retry. Default outcome text
handed repair and uncertain-effect choices to the user.

This refines the recovery and reporting contract developed in the original Chief
goal-supervision recommendation. The current public contracts are documented in
[runtime execution and state ownership](./adr-runtime-execution-and-state-ownership.md)
and the [continuous-operation guide](../guides/chief-continuous.md). The existing port
boundaries, single scheduler state authority and completion gates remain authoritative.

## Options

1. Unconditionally retry every paused worker. This is easy to schedule but can replay
   uncertain external effects, override cancellation or reset spent allowances.
2. Route repair decisions through the selected Chief, persist an explicit wait
   decision and apply pure bounded eligibility before automatic continuation.
   This preserves the original goal, selected model, evidence and accounting.

## Decision

Use option 2. Decision ownership covers executive judgment throughout the work:
interpret user intent and business context, identify opportunities, compare strategies,
synthesize Director advice, mobilize Actors, evaluate outcomes and adapt the strategy.
The shared Chief role governs planning, strategic goal selection, supervision and final
review. Continuous goal selection consults the permanent Directors before choosing a
goal; unavailable advice is recorded evidence, while integrity and budget failures remain
protected. Existing interpretation, reason, instructions and report fields carry the
judgment without adding another decision schema.

The Chief also chooses repair, reassignment, replanning, waiting or stopping.
Worker blockers go to the Chief. Scheduled waits continue the same saved mission
without an operator retry decision. Eligible child and decision retries are bounded
and checkpointed before dispatch. Native usage and spent limits survive retries.

A completed external action can receive further review and a distinct repair plan;
it cannot be silently repeated. Unknown external effects allow evidence-preserving
Chief wait or stop, never an invented completed/not-applied result. No generic
trusted destination observer exists, so this change does not claim automatic
reconciliation of arbitrary external effects. Unsupported access, exhausted limits
and final Chief stop are unresolved reports, not approval or repair-choice questions.
The user retains optional cancellation and advanced controls.

## Consequences

Autonomy is measured by verified completion with zero routine user decisions.
A report of an unresolved outcome is not successful completion. Initial credentials
and tool access cannot be fabricated. The runtime must not extend an explicitly
saved spending envelope or consume calls after cancellation.

## Validation

Use deterministic ports, actual temporary Node processes and temporary Git fixtures.
Verify waiting survives early resume, eligible recovery preserves every spent counter,
container unavailability reaches Chief repair and requires fresh recovery evidence,
completed external effects are not replayed, and failed preflight before dispatch is
not reported as an unknown external effect. Verify uncertain effects, cancellation,
read-only breaches, original acceptance and explicit limits remain protected. No live
model, cloud, container or report-channel calls are part of this validation.
Verify the next strategic goal sees actual Director advice and available skills; a
Director's unavailable CLI must not fabricate an opinion or veto the Chief's judgment.
