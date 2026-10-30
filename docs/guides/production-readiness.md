# Production readiness

For pre-authorized automatic integration, use [unattended code delivery](unattended-delivery.md). It retains the goal and execution budget, gates source integration on independent reviews and trusted checks, and records commit and remote observations. A bounded supervised pilot remains available when delivery has not been authorized.

## Current acceptance evidence

The 2026-10-28 Codex arithmetic fixture completed work interruption, operator reconciliation, same-Mission resume and trusted final verification. Its original 1,200-second/16-run budget remained unchanged: 13 runs were used and 77.4 seconds remained. Observed owned PIDs, process groups and active markers were clear. The full-trace observer and host evidence publisher were specific to that fixture; ordinary orders do not acquire that trace automatically.

The 2026-10-30 real-code pilot changed AV's existing test file with two lint errors. **Code patch: independently accepted and applied to main. Full native pilot: interrupted and incomplete.** The worker completed the patch, the Technical Director accepted the task, the backend's fixed verifier passed, and the Chief's final review passed all five criteria. The operator separately reviewed the diff and ran the fixed seven-test/21-assertion contract and lint successfully. The accepted file's SHA-256 is `8936881a4756bd383af6ab9177a11348ed0184c6fe6f991a333c933f33e915f6`.

The original Mission started at `00:05:19.601 UTC`, with 20 runs, 1,800 seconds and one concurrent Actor. Its goal, verifier, start time and budget were preserved; 12 runs were spent and all settled. At the precommitted 1,770-second observation boundary (`00:34:49 UTC`), the controller sent SIGINT during reporting, retaining 30 seconds for cleanup. The CLI exited 2, the Mission remained paused, and the receipt was incomplete. Known owned processes and active markers were clear. Task acceptance does not establish full Mission completion or npm publication.

The evidence retains two task-contract/Actor-skill source repairs and two normal retries of the same Mission. It also retains a controller correction for PID-less startup markers and the first CLI exit code's missing observation. The exact native model remains unconfirmed and actual cost is null. Private records, including `patch-acceptance.json`, remain under `.agents/results/runtime/real-code-pilot-20261030/`. The operator-owned verifier was outside the Actor's writable workspace; existing dependency links were reused without dependency or browser installation.

Release-please owns the generated `CHANGELOG.md` format. Biome skips formatting for that file while retaining its other checks and formatting ordinary source and documentation.

## Supervised real-code procedure

1. Record the source/base revision, intended files, selected Actor/vendor/model, permissions and trusted verification command. Keep production deployment, payment and posting access outside a file-change pilot. Prepare required OMA agent definitions and assigned skills before dispatch; a readiness failure remains unresolved.
2. Start one goal with explicit bounds:

   ```sh
   av order "Fix one scoped issue; preserve its existing tests" \
     --once --no-supervise --parallel 1 --runs 20 --duration 1800 \
     --verify '<existing trusted test command>'
   ```

   Replace the placeholder with the intended repository's command. These limits are an initial observation budget, not a completion guarantee. `av order` otherwise starts continuous operation by default.
3. Retain the printed Mission ID and worktree. After repairing an authorized prerequisite, use `av order --resume MISSION_ID --retry`; keep the original goal, checks, start time and spent allowances. An unknown execution requires trustworthy termination evidence and [reconciliation](chief-missions.md#advanced-manual-controls) before another attempt. Exhausted limits require an explicit operator decision; retries do not reset them.
4. Review the result independently. Inspect changed paths and test bodies, including the original assertions, names and exercised behaviors. Tests must remain active and expectations must retain their meaning. For the AV pilot, confirm that only the assigned test file changed and the seven-test/21-assertion contract remains intact. Full Mission acceptance requires trusted verification, current task/final reviews, a completed Mission, the expected CLI exit, and clear owned processes/markers. A separately verified and manually reviewed patch can be integrated while retaining an incomplete Mission outcome; preserve both records.
5. Integrate the reviewed AV change through the normal repository workflow. Require CI for the exact integrated revision, including tests, lint, no-emit type checks and existing distribution checks. Associate that revision and accepted diff with the Mission evidence.
6. Use the existing Release/npm pipeline for authorized publication. Candidate discovery and the final merge both require matching project/manifest versions at the pinned commits and a candidate version greater than main. Repair release-please's version selection if this gate stops the release. Check the actual workflow conclusions, release tag and published package metadata. The working tree's version field or a queued workflow does not establish publication. Replace `X.Y.Z` with the actual release version:

   ```sh
   npm view agent-valley@X.Y.Z version dist.integrity --json
   npm view agent-valley dist-tags --json
   ```

   Confirm that the selected version and intended dist-tag match the release. Record workflow URLs and registry observations separately from native code-work acceptance.

## Evidence and wider operating scope

Retain source and base revisions, goal/check bindings, changed paths, provider/model provenance, original start and budget, spent runs, review and verification results, operator interventions, final process/marker state and release observations. Preserve unknown usage/cost as unknown; configured-price estimates are not billing receipts or a provider-enforced spending cap.

Promotion beyond the supervised pilot needs evidence for the intended workload:

- **Continuous operation:** representative repeated workloads, bounded failure/restart behavior, actual observation and alert delivery, and an operation-wide spending control. Per-child/decision `--runs`, `--duration` and estimated `--cost` are not a lifetime operation cap. `--cycles` counts verified improvements, including across restarts.
- **Persistent state:** a backup from the deployed storage configuration and a restore drill that verifies actual records, ownership and recovery behavior. Preserve Mission records and retained worktrees along with any team ledger required by the deployment.
- **External actions:** explicit target permissions and a destination-specific observer. Exercise response loss, cancellation and reconciliation without duplicate effects. AV has no generic destination observer and does not guarantee exactly-once execution for every native tool call.
- **Other providers and endpoints:** qualify real execution, cleanup and recovery behavior separately. The bounded Codex fixture and a local code pilot do not establish production A2A endpoint behavior or unattended long-running reliability.

See [Mission recovery](chief-missions.md#advanced-manual-controls), [continuous operation](chief-continuous.md), [observability](../specs/observability.md), [team ledger](team-ledger.md), and [A2A execution](a2a-execution.md).
