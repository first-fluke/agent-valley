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

## Cached skill read-reference checks

Chief Director orders and continuous missions can consume OMA's installed-skill matrix. This is independent of `oma.mode` receipt validation. The default is disabled. It requires an OMA CLI implementing `oma-skill-matrix-v2`; updating a source checkout alone does not update an already installed `oma` executable. If a local plan reports unsupported options or an unsupported contract, install a compatible OMA CLI before enabling this setting.

Generate a plan for the actual target repository first. A plan reads and hashes installed skill files without invoking a vendor or model:

```sh
oma skills matrix --project-root /absolute/target-repository \
  --skills oma-debug,oma-qa --delivery injected --vendors claude,codex --json
```

Create a cached measurement explicitly when ready. Set `CLAUDE_MODEL_ID` and `CODEX_MODEL_ID` to the intended native model identifiers. Live runs can incur vendor charges; AV never starts them automatically. The report destination must be a new file in an existing directory.

```sh
oma skills matrix --project-root /absolute/target-repository \
  --skills oma-debug,oma-qa --delivery injected --vendors claude,codex \
  --claude-model "$CLAUDE_MODEL_ID" --codex-model "$CODEX_MODEL_ID" \
  --live --yes --json --report /absolute/path/to/matrix-2026-10-07.json
```

Set this in the configuration project's `av.yaml`:

```yaml
oma:
  skill_compatibility:
    report_path: /absolute/path/to/matrix-2026-10-07.json
    max_age_hours: 168
    mode: warn
```

Relative `report_path` values resolve from the directory containing `av.yaml`, not from a mission worktree. The default maximum age is 168 hours. `warn` adds diagnostic results to `av doctor`, mission history and operation reports without changing routing. `require` permits work candidates only when all of that Actor's selected skills have current passing evidence. Existing price and measured success ranking runs after this filter. An explicit Actor/model fails rather than silently changing routes. Select exact model identifiers reported in `cells[].model`; a requested alias in `models` or an unpinned native default is not proof of the model used.

For automatic routing, pin these measured model identifiers in `chief.routing.candidates` before changing the mode to `require`. For an explicit `--actors` roster, set each work Actor's `model` field. `actor.model` selects the Chief Director's model and does not pin automatic work candidates.

```yaml
chief:
  routing:
    candidates:
      - actor_type: claude
        model: "<exact Claude cells[].model value>"
      - actor_type: codex
        model: "<exact Codex cells[].model value>"
```

Every work dispatch rereads the cached report and runs a bounded local OMA plan against its actual mission or parallel task worktree, plus native CLI `--version` probes. It compares the selected skills' hashes and complete reference coverage, OMA version, platform, architecture, native CLI version and observed model. It requires a completed live installed report with injected delivery, the supported protocol, mandatory successful read checks and no missing or excluded references. A report may cover more skills than the current Actor selects. Synthetic probes, plans, stale results, changed files, incomplete coverage, unknown models and unsupported vendors do not satisfy `require`. Failed and unknown results remain distinct in diagnostics. An unknown required diagnostic makes `av doctor` exit nonzero. No selected skills means no skill compatibility claim is needed.

`av doctor` checks the cached bundle against the configured `actor.type` and `actor.model`; it does not infer which skill subset a future mission will select. Work dispatch checks its own selected skills and routing candidates independently.

The policy path, mode and age limit are saved with the mission. Resuming preserves that policy and rechecks current evidence; it does not preserve an earlier pass indefinitely. To refresh a saved mission's report, replace the file at its saved path with a newly generated report after reviewing it. OMA writes new report files, so generate a separate file first, then replace the configured cache file yourself.

This evidence covers reading the installed `SKILL.md` and its audited direct literal references while its body is injected as AV injects selected skill bodies. It does not certify task quality, native skill activation or AV's complete execution environment. AV uses Codex `app-server`; the matrix uses `codex exec`. Their runtime settings differ. Claude and Codex are the supported measured vendors; the other six AV vendors remain unknown for this protocol. The filter applies only to Chief Director mission work dispatch, including parallel worktrees and resume. Chief planning, adviser and review stages, and tracker-orchestrator work without a selected-skill roster, are outside this filter. Existing completion checks still apply.

AV reads bounded regular JSON files and never displays cached transcripts, file contents, environment values or credential errors. Reports are operator-controlled local evidence, not signed attestations. Tests use fixture reports and subprocesses; they do not establish that live vendor executions passed.
