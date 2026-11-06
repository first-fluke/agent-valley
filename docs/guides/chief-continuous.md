# Continuous Chief operation

Use `av order` to keep improving a service under an operating charter. The Chief selects a concrete goal, supervises Actors and Director reviews, verifies the result, then uses the accepted code and observed outcomes to choose the next improvement. Add `--once` to complete one goal and exit.

New continuous orders apply each verified cycle's product changes to the original source worktree before counting that improvement or choosing the next goal. The source branch and HEAD are pinned, and the index and unrelated edits are preserved. This updates files without staging, committing or pushing them. A conflicting target file, source ref change, uncertain partial application or cancellation retains the verified child and pauses acceptance. Resume retries source application instead of rerunning completed work.

Use `--source-integration snapshot-only` to retain results only in private workspaces. Saved operations keep their existing policy; older operations without a source policy retain snapshot-only behavior. To enable source application on an existing stopped operation, run `av order --resume OPERATION_ID --source-integration worktree`. AV first applies any accepted cycles since the last source application, retaining the same decision, child and spent budgets. Commit and push delivery remains separately enabled with `--deliver` as described in [unattended delivery](./unattended-delivery.md).

The Chief interprets the charter and business context, identifies opportunities, compares strategies and synthesizes Technical Director, Design Director and Marketing Director advice before choosing the next goal. It acts on its judgment, evaluates real outcomes and adjusts the strategy. Actors return evidence and blockers to the Chief. The user receives decisions, reasons, results, lessons and next actions. This judgment stays within the original charter, available permissions and saved limits. Missing authorization, credentials or trustworthy external-effect evidence are reported unmet prerequisites, never invented permissions or success.

When upgrading scripts that expected the previous single-goal default, add `--once`; MCP callers use `once: true`. Replace calls to the former `av_operate` MCP tool with `av_order`, passing the charter as `goal`. Saved mission and operation records retain their execution mode on resume.

```bash
av order "Improve usability, reliability and revenue; measure results and report each decision"
# Optionally stop after two verified improvements:
av order "Improve maintainability" --cycles 2
# Complete one goal and stop:
av order "Fix the login failure" --once
av operations
av operations --report OPERATION_ID
```

Run from the directory containing `av.yaml`, or pass `--workspace /absolute/path/to/repo`. The saved Chief Director vendor/model is retained, including the native default when no exact model was selected. `--actor`, `--model`, `--actors`, `--verify`, `--oma`, and execution-limit flags work as on orders. Installed OMA skills and available Actor CLIs remain selectable by the Chief.

The default operation continues until stopped or paused. Model usage and API charges can continue across many improvements; AV does not manage subscription allowances. `--runs`, `--duration` and `--cost` apply separately to each improvement and goal-selection checkpoint. They are not a lifetime operation spending limit. Spent budgets within a checkpoint survive retries. `--cycles N` counts verified completed improvements, cumulatively across restarts. Waiting, failed work and interrupted decisions do not count. `--interval SECONDS` controls the wait before another decision when no justified goal exists; the default is 300 seconds.

## Decisions and measurements

The Chief inspects the latest accepted product snapshot, previous mission reports, organization outcomes, configured measurements and available tools. It selects one goal with reasons and evidence, or waits for an observation or condition. Selection instructs read-only inspection and rejects changes to product files. Native provider permissions govern external tools; repository fingerprints cannot prevent cloud or MCP mutations.

Each improvement keeps its own acceptance contract, independent review, measured-outcome requirements and report. Missing or stale observations do not count as business success. Source-collected measurements retain their attribution and measurement windows; they do not establish causation. When an authoritative metric source is needed, configure it through setup or [metric-source settings](./chief-integrations.md#automatic-business-metric-sources). A Chief may instead select an integration or inspection goal when access is missing; it cannot invent a successful measurement.

Optional [container observation](./chief-containers.md) collects Docker/OrbStack or Kubernetes state and bounded logs from configured targets. New failure evidence can wake an idle operation before its usual next decision. Enabled target health is checked again before a child completes. Unhealthy or unavailable observations return to the Chief for an authorized repair, bounded wait or explained stop; missing evidence remains unresolved. The collector reads runtime evidence; the Chief delegates repairs and delivery within the charter.

Reports explain decisions and results in plain language. Child reports and Aside screenshots/videos use existing [attachment delivery](./chief-integrations.md#replaceable-reporting-channels). `av operations --report` shows the charter, state, accepted workspace and recent child IDs. Read those child reports for checks and limitations. Operation state lives in `.agent-valley/operations/`, reports in `.agent-valley/operation-reports/`, and decision checkpoints in `.agent-valley/operation-decisions/`. Recent decision context is bounded; child records and snapshot receipts remain available for recovery.

## Tools and credentials

AV discovers Docker, OrbStack commands, kubectl, AWS, gcloud, Azure, Cloudflare and Sentry executables plus configured MCP server names in supported project/user client files. Discovery returns metadata only. Installed executables and configured servers are not proof of authentication, a running Docker daemon or permission to a service. Native Actors use the tools their client actually exposes. AV prepares missing project MCP namespaces in isolated workspaces from `.mcp.json`, `.cursor/mcp.json`, `.qwen/settings.json`, `.gemini/settings.json` and `.codex/config.toml`. Existing workspace files are preserved. Generated copies have private permissions and Git exclusions; client approval, trust and model settings are not copied. User-level MCP settings still use the native client configuration.

Existing tool login profiles can be used through the Actor's normal home directory. To pass specific exported credential or profile variables to Actors, list their names in `av.yaml` or global `settings.yaml`:

```yaml
chief:
  tool_env_keys:
    - AWS_PROFILE
    - GOOGLE_APPLICATION_CREDENTIALS
    - SENTRY_AUTH_TOKEN
```

List only variables the task needs and export them before starting. Values are resolved at Actor spawn and are not written to mission configuration, prompts, usage records or tool-discovery output. Missing named values fail with fix instructions. Runtime, Git and managed-run override variables cannot be forwarded through this setting. Metric-source and reporting credentials are resolved by their adapters and need no Actor forwarding unless an Actor also needs them.

Cloudflare, Clarity, Google Analytics, Sentry and other services can supply evidence through configured native tools/MCP, authenticated CLIs or supported HTTP/file metric sources. Their access and actual exposed operations determine what the Chief can do. AV does not create service accounts or install arbitrary MCP servers merely because their names appear in a charter.

## Stop and recover

Ctrl-C or SIGTERM stops the operation and active runtimes, retaining its current child and checkpoints. Resume from the same project directory:

```bash
av order --resume OPERATION_ID
# Extend a completed bounded operation to five total improvements:
av order --resume OPERATION_ID --cycles 5
```

Recoverable child or decision failures continue through bounded recovery using the original checkpoint, charter, selected Chief and spent budgets. A Chief-selected wait retains the same child and automatically resumes at its saved `nextRunAt`; completed external actions remain preserved. A stopped or unresolved child is never replaced with a new mission to evade its evidence or limits.

A confirmed native Actor timeout receives bounded delayed retries with the saved timeout and remaining execution budget. It does not spend a malformed-JSON correction attempt. A resumed operation joins a child that another live coordinator already owns, then reads its latest checkpoint and accepts verified completion once. Joining does not start a second Actor or spend another recovery attempt; cancelling the joining parent does not cancel the other coordinator's child.

A cancelled Chief planning call can retain its unused JSON correction allowance only when the saved AV interruption and a uniquely matched, failed local run prove settled termination without a response. Actual calls, elapsed time, cost and recovery spending remain retained. Parsed plans, malformed responses and running or uncertain outcomes are not released by this recovery.

`av order --resume ID` detects whether the saved record is an operation or a single mission. When an implicitly selected child finishes with verified evidence, the command reconnects its original blocked order and continues acceptance automatically. A live parent already handling acceptance is preserved. Explicitly interrupted or legacy paused orders remain operator-controlled. `--once --resume CHILD_ID` runs only the child without reconnecting its order. After a user stop or an externally repaired prerequisite, the following advanced manual controls can resume the original child and operation:

```bash
av order --resume CHILD_ID --retry
# Or observe/reconnect the existing child through its parent directly:
av order --resume OPERATION_ID
```

If a goal-selection checkpoint stopped after exhausting invalid-JSON corrections, repair its response source and run `av order --resume OPERATION_ID --retry`. This authorizes one corrected response on the same decision. AV saves and consumes that permission before dispatch; it retains spent calls, elapsed time, cost, automatic retry counts and outer recovery attempts. An ordinary resume does not renew the permission. Authentication, integrity and uncertain-effect blockers still require their own repair or reconciliation. Grok decisions use the native terminal result text, so earlier progress messages cannot corrupt the JSON response.

If the active goal-selection checkpoint itself reached a limit, `av order --resume OPERATION_ID --runs 400 --duration 172800` can increase that decision's limits while retaining prior spending. `--cost`, or the pair `--account-run RUN_ID --account-cost USD`, can resolve its cost limit or a provider charge you have inspected. These flags apply only when a decision checkpoint is active; future child settings stay as originally saved. Child limits and uncertain effects use the child resume controls above. The operation report includes its active decision ID, whose usage record is in the decision checkpoint directory.

Interrupted external effects remain evidence-gated on the original child. Without trustworthy destination evidence, the Chief can wait or report an unmet prerequisite; it cannot guess the effect's outcome or repeat it. AV does not provide a generic destination observer. [Advanced manual reconciliation](./chief-missions.md#advanced-manual-controls) is available when an operator has independently checked the destination. Resuming an operation does not resolve uncertainty or reset child budgets. Repeated goal/evidence decisions wait. Unavailable selected Chief access, corrupt records, mismatched snapshots and exhausted recovery limits pause with the cause. Live locks prevent concurrent runners.

Verified changes are carried to the next improvement using private Git snapshots, including uncommitted product changes. In worktree source mode, only the verified change between successive snapshots is applied to the original source files before the next cycle; preexisting operator changes captured in the initial snapshot are not promoted. Runtime files and native client/MCP configuration are excluded. A verified `.gitignore` change preserves AV's canonical runtime exclusion when that exclusion is the only additional source edit; other overlapping edits still pause. The source index and refs remain unchanged. Snapshot-only mode leaves the original checkout unchanged. Workspaces retain the original delivery remote; publishing, pushing and deployment still need to be within the operating charter and available permissions.

Progress and reports distinguish child verification, source file application, Git commit and confirmed remote push. A child finishing does not mean the charter is complete. The parent records acceptance and continues with a visible decision checkpoint unless it reaches a cycle limit or a saved wait/stop condition.

## Retained workspaces

After stopping the operation so its owner lock is released, preview reclaimable frozen baseline clones with `av operations --prune OPERATION_ID`. Add `--apply` to remove only the candidates that pass the ownership, clean-tree, liveness and recovery checks. The initial, current, previous and last source-applied baselines, active references, all child/decision workspaces, failed-work evidence and original receipts are retained. Unknown or modified artifacts are skipped with reasons. This command does not remove Git objects from the current baseline or delete source files.

Accepted cycles also receive immutable per-cycle receipts, so pruning can verify new cycles after they leave the report's recent 20-entry history. Older legacy artifacts without acceptance proof remain retained. Removal has its own prepared/completed receipts; an intact interrupted quarantine can resume, while changed or partially removed content is preserved for inspection. Pruning is explicit and does not run automatically during a mission.

## MCP clients

Submit the operating charter as `goal` to `av_order`; it returns an operation ID immediately. Set `once: true` on the same tool to complete one goal and receive a mission ID. `av_operations`, `av_operation_status`, `av_operation_report`, `av_operation_resume` and `av_operation_cancel` inspect and control continuous operations. Use a stable `requestId` to deduplicate repeated submissions. Disconnecting the client leaves the detached operation running. Cancellation is asynchronous: poll until the operation is paused and its supervisor has stopped.

Managed Actors cannot recursively start or resume operations. They return their findings to the supervising Chief. Use existing `av_status` and `av_report` with child mission IDs for detailed evidence. Operation resume retains the original charter and settings; CLI `--cycles` can extend a bounded operation.
