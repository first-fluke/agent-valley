# OMA completion evidence

OMA receipt validation is optional. With the default `oma.mode: off`, code tasks still require detected code changes and a configured passing verification command. Text output alone never completes a task.

For an analysis-only task, the operator must configure a report path in `valley.yaml` or a matching routing rule:

```yaml
task:
  kind: analysis
  report_path: .agents/results/analysis-{{attempt.id}}.md
```

The report must be a nonempty regular file inside the current worktree, written during the current attempt. The attempt ID in the configured path prevents an earlier run's report from satisfying completion. A missing, stale, wrong-workspace, or escaping symlink report blocks Done. The default task kind is `code`.

To require OMA evidence, configure the target project's `valley.yaml`:

```yaml
oma:
  mode: strict
verify:
  command: npm test
```

Strict mode currently supports OMA CLI **15.0.4** and its v1 agent-run receipts. Run `av doctor` from the target project to check the CLI, trigger table, routed workflow files, and `verify.command`. A routing rule may override `verify.command` for that route, but the project-level command is required so the default route also has a check.

At dispatch, Valley writes a one-task OMA session plan in the issue worktree. Its session and task IDs equal the Valley attempt ID; the plan pins the operator-configured verification command. The agent prompt contains `oma agent begin`, `verify --required`, and `finish` instructions for that exact attempt and worktree.

Before auto-commit or delivery, Valley checks the completed OMA receipt's run, task, session, worktree, timestamps, unresolved work, changed inputs, and required check result. It also calls OMA's read-only `agent status` command, which revalidates the current workspace, contract, and artifact hashes. Valley uses the pinned OMA check result instead of running the same command again. Code work needs a nonempty `changedFiles` claim and a changed product-input fingerprint. Analysis work needs a bound report artifact. Missing, malformed, stale, failed, or unsupported evidence blocks Done. Uncommitted code is sent back for repair because auto-commit would invalidate a verified receipt.

After delivery succeeds, Valley persists a pending tracker finalization before asking the tracker to move the issue to Done. If that update fails, later reconciliation and restart recovery retry only the tracker update. The agent, verification, merge, push, PR creation, and usage accounting are not repeated. A confirmed cancellation clears the pending record without a Done event or DAG unblocking.

OMA 15.0.4 has no machine-readable read-only command that exposes its full `resultEvidenceValid` verdict. Valley accepts only the exact `<agent>:completed` status line from that version and checks the required verification receipts itself. Unknown output or an unavailable CLI fails closed. The receipts are local evidence against accidental stale reuse, not a security boundary against an agent that deliberately edits its own records.
