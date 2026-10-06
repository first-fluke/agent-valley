# OMA completion evidence

OMA receipt validation is optional. With the default `oma.mode: off`, code tasks still require detected code changes and a configured passing verification command. Text output alone never completes a task.

`av setup` offers installation or update of the latest OMA CLI and skills in the selected target repository. This prepares skill use for Chief Director orders; it does not enable strict receipts. Existing OMA configuration is preserved. See [environment setup](./environment-setup.md) for the wizard flow.

For an analysis-only task, the operator must configure a report path in `av.yaml` or a matching routing rule:

```yaml
task:
  kind: analysis
  report_path: .agents/results/analysis-{{attempt.id}}.md
```

The report must be a nonempty regular file inside the current worktree, written during the current attempt. The attempt ID in the configured path prevents an earlier run's report from satisfying completion. A missing, stale, wrong-workspace, or escaping symlink report blocks Done. The default task kind is `code`.

To require OMA evidence, configure the target project's `av.yaml`:

```yaml
oma:
  mode: strict
verify:
  command: npm test
```

Strict mode uses the installed OMA CLI and validates its actual **v1 agent-run receipt contract**. AV has no exact CLI release pin: later releases, including a new major release, are accepted when their receipts and native status proof satisfy this contract. OMA 15.7.1 passed the native code, analysis, tampered-evidence and Chief task-gate tests. A valid version number alone does not establish receipt compatibility. Run `av doctor` from the target project to check the CLI, trigger table, routed workflow files, and `verify.command`. A routing rule may override `verify.command` for that route, but the project-level command is required so the default route also has a check.

Install or update the CLI with `npm install -g oh-my-agent@latest`. Native receipt commands use `--project-root`; `--root` is not accepted. The project-root and workspace arguments must point to the current issue worktree.

Before every new strict OMA attempt, AV checks the registry's current `latest` release and updates the CLI when the installed version differs. Concurrent preparations share an in-flight check or update. A registry or installation failure leaves the attempt undispatched; AV does not silently use an older CLI. Read-only receipt validation checks existing evidence without installing packages or querying the registry.

At dispatch, Valley writes a one-task OMA session plan in the issue worktree. Its session and task IDs equal the Valley attempt ID; the plan pins the operator-configured verification command. The agent prompt contains `oma agent begin`, `verify --required`, and `finish` instructions for that exact attempt and worktree.

`begin` returns a `runId` and `claimPath`. After committing code and running the pinned verification, the agent writes a JSON claim with `status: "completed"`, relative `changedFiles`, an empty `unresolved` array, and an `artifacts` array of relative paths. Analysis claims use an empty `changedFiles` array and include the current report path in `artifacts`. `finish` converts artifact paths into hashes in the receipt.

Before auto-commit or delivery, Valley checks the completed OMA receipt's run, task, session, worktree, timestamps, unresolved work, changed inputs, and required check result. It also calls OMA's read-only `agent status` command, which revalidates the current workspace, contract, and artifact hashes. Valley uses the pinned OMA check result instead of running the same command again. Code work needs a nonempty `changedFiles` claim and a changed product-input fingerprint. Analysis work needs a bound report artifact. Missing, malformed, stale, failed, or unsupported evidence blocks Done. Uncommitted code is sent back for repair because auto-commit would invalidate a verified receipt.

After delivery succeeds, Valley persists a pending tracker finalization before asking the tracker to move the issue to Done. If that update fails, later reconciliation and restart recovery retry only the tracker update. The agent, verification, merge, push, PR creation, and usage accounting are not repeated. A confirmed cancellation clears the pending record without a Done event or DAG unblocking.

AV accepts only the exact `<agent>:completed` native status proof and checks the required verification receipts itself. Unknown schemas, malformed CLI version output, unknown status output or an unavailable CLI fail closed. Incompatible protocol errors include the installed CLI version and instructions to update AV and OMA before generating new verified evidence. The receipts are local evidence against accidental stale reuse, not a security boundary against an agent that deliberately edits its own records.

The native-contract integration tests create temporary git repositories and exercise `begin → verify --required → finish → status` for both code and analysis. They also change code or report content after completion and require rejection. These tests run with the installed CLI, without an exact release guard, and do not invoke a model or skill. CI requires OMA to be available; missing or malformed CLI availability fails the suite rather than skipping native contract tests.
