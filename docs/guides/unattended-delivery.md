# Unattended code delivery

An authorized order can implement a change, review and verify it, commit it on the source branch and push it without a per-run approval. Enable delivery explicitly and name the exact product files. The default order still retains its work in the Mission workspace.

```sh
av order "Implement the scoped change" --once \
  --workspace /absolute/repository \
  --verify '<trusted acceptance command>' \
  --deliver main \
  --delivery-paths '["src/feature.ts","test/feature.test.ts"]' \
  --delivery-message "$(cat approved-message.txt)" \
  --parallel 1 --runs 20 --duration 1800
```

`approved-message.txt` contains the intended commit message and any trailers required by the repository. `--delivery-remote` selects an existing named Git remote; its default is `origin`. The source must start on the selected branch with a clean index and worktree. Preserve unrelated edits before creating the order.

The saved policy pins the branch, remote, original base, exact paths and message. A resume uses that policy rather than replacement delivery flags. Private settings, credentials and runtime paths cannot be delivered. A changed path outside the allowlist, a symlink, stale verification or an unexpected source change stops delivery while preserving the work.

## Completion and recovery

The coordinator requires completed tasks, independent reviews, trusted verification and a current workspace fingerprint. A verified report is rendered from those records without another Actor call. Its final fingerprint, health and cancellation checks still apply.

Director advice and the initial Chief plan allow one correction of a malformed structured response. The saved attempt count survives restarts, and both calls use the original run and time allowances. Advice that still cannot be parsed is recorded as unavailable for the Chief to assess. Task reviews, final review and trusted verification retain their completion gates.

Delivery then records the patch digest, expected tree and unique nonce before changing the source. It runs the repository's normal commit and push hooks. The saved commit is bound to its original parent, tree, message and Mission nonce. Git output capture has a fixed size limit and timeout.

The delivery phases are `pending`, `prepared`, `committed`, `pushed`, `unchanged` and `blocked`. A pending delivery keeps the verified work and resumes only delivery; it does not rerun the implementation. A completed-work order exits 2 until delivery succeeds or is explicitly recorded as unchanged. Source drift or a nonrecoverable condition remains blocked.

Before retrying a push, AV observes the remote branch. A confirmed commit, including one already followed by newer remote commits, completes delivery without another push. An unrelated remote branch is never overwritten. Delivery is a Git receipt; a repository's deployment or package workflow has its own outcome.

## Persistent watcher

Set `chief.execution.auto_resume: true` in the `av.yaml` used by the order store, and keep the native CLI credentials available to the service account. Run the watcher from that same directory:

```sh
av missions --watch
```

The watcher checks saved Missions and continuing operations. It skips live owners and operation children handled by their parent. Matching local process markers can prove termination and permit the Chief to reassess the original task. Missing, reused, remote or uninspectable process identities do not authorize replay. Explicit operator stops and exhausted budgets remain stopped; automatic recovery retains the original start and spent allowances.

The supervisor observes the original deadline while its worker initializes or runs. A deadline requests termination of the owned worker, with bounded escalation if it ignores the first signal, and records a budget failure after confirmed exit. Unconfirmed termination preserves the lock and process evidence and returns an unresolved error. External cancellation keeps its separate interrupted outcome.

Use an OS process supervisor for the watcher itself. On macOS, a user LaunchAgent can run the command with `RunAtLoad`, `KeepAlive.SuccessfulExit: false`, `ProcessType: Interactive` and a restart throttle. Background QoS can delay CLI initialization by minutes; the controlled 2026-10-30 comparison completed the same read-only command in 3.12 seconds with Interactive QoS while Background did not finish within 30 seconds. Pin the executable and working directory, pass credential paths rather than secret values, and send logs to a managed log sink. The OS restarts a crashed watcher; the product watcher resumes saved work. A deliberate graceful stop can exit normally without an immediate restart.

## Release acceptance

For AV's own repository, the authorized main push starts the existing CI, pinned release-candidate verification, guarded merge, tag and npm publication. The release guard rejects non-increasing versions. Generated changelog formatting belongs to release-please.

Retain the Mission, original contract, verification and review records, delivery nonce and commit, process-recovery evidence, source CI, verified release candidate, tag, publication workflow and public registry metadata. The npm `gitHead` must match the published tag; the delivered code commit must be its ancestor. A queued workflow or a private workspace snapshot does not establish publication.

The 2026-10-30 unattended acceptance harness is stored under `.agents/results/runtime/unattended-code-20261030/`. Its receipts record the actual outcome, fault injections and operator interventions. Earlier interrupted cases remain separate evidence. See [production readiness](production-readiness.md) for evidence limits and wider workloads.
