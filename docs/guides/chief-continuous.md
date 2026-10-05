# Continuous Chief operation

Use `av operate` to keep improving a service under an operating charter. The Chief selects a concrete goal, supervises Actors and Director reviews, verifies the result, then uses the accepted code and observed outcomes to choose the next improvement. `av order` still completes one goal and exits.

```bash
av operate "Improve usability, reliability and revenue; measure results and report each decision"
# Optionally stop after two verified improvements:
av operate "Improve maintainability" --cycles 2
av operations
av operations --report OPERATION_ID
```

Run from the directory containing `av.yaml`, or pass `--workspace /absolute/path/to/repo`. The saved Chief Director vendor/model is retained, including the native default when no exact model was selected. `--actor`, `--model`, `--actors`, `--verify`, `--oma`, and execution-limit flags work as on orders. Installed OMA skills and available Actor CLIs remain selectable by the Chief.

The default operation continues until stopped or paused. Model usage and API charges can continue across many improvements; AV does not manage subscription allowances. `--runs`, `--duration` and `--cost` apply separately to each improvement and goal-selection checkpoint. They are not a lifetime operation spending limit. Spent budgets within a checkpoint survive retries. `--cycles N` counts verified completed improvements, cumulatively across restarts. Waiting, failed work and interrupted decisions do not count. `--interval SECONDS` controls the wait before another decision when no justified goal exists; the default is 300 seconds.

## Decisions and measurements

The Chief inspects the latest accepted product snapshot, previous mission reports, organization outcomes, configured measurements and available tools. It selects one goal with reasons and evidence, or waits for an observation or condition. Selection instructs read-only inspection and rejects changes to product files. Native provider permissions govern external tools; repository fingerprints cannot prevent cloud or MCP mutations.

Each improvement keeps its own acceptance contract, independent review, measured-outcome requirements and report. Missing or stale observations do not count as business success. Source-collected measurements retain their attribution and measurement windows; they do not establish causation. When an authoritative metric source is needed, configure it through setup or [metric-source settings](./chief-integrations.md#automatic-business-metric-sources). A Chief may instead select an integration or inspection goal when access is missing; it cannot invent a successful measurement.

Reports explain decisions and results in plain language. Child reports and Aside screenshots/videos use existing [attachment delivery](./chief-integrations.md#replaceable-reporting-channels). `av operations --report` shows the charter, state, accepted workspace and recent child IDs. Read those child reports for checks and limitations. Operation state lives in `.agent-valley/operations/`, reports in `.agent-valley/operation-reports/`, and decision checkpoints in `.agent-valley/operation-decisions/`. Recent decision context is bounded; child records and snapshot receipts remain available for recovery.

## Tools and credentials

AV discovers Docker, OrbStack commands, AWS, gcloud, Azure, Cloudflare and Sentry executables plus configured MCP server names in supported project/user client files. Discovery returns metadata only. Installed executables and configured servers are not proof of authentication, a running Docker daemon or permission to a service. Native Actors use the tools their client actually exposes. AV prepares missing project MCP namespaces in isolated workspaces from `.mcp.json`, `.cursor/mcp.json`, `.qwen/settings.json`, `.gemini/settings.json` and `.codex/config.toml`. Existing workspace files are preserved. Generated copies have private permissions and Git exclusions; client approval, trust and model settings are not copied. User-level MCP settings still use the native client configuration.

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
av operate --resume OPERATION_ID
# Extend a completed bounded operation to five total improvements:
av operate --resume OPERATION_ID --cycles 5
```

A paused or failed child is not replaced with a new mission. Inspect its error, repair the blocker and explicitly resume that child, then resume the operation:

```bash
av order --resume CHILD_ID --retry
av operate --resume OPERATION_ID
```

If the active goal-selection checkpoint itself reached a limit, `av operate --resume OPERATION_ID --runs 400 --duration 172800` can increase that decision's limits while retaining prior spending. `--cost`, or the pair `--account-run RUN_ID --account-cost USD`, can resolve its cost limit or a provider charge you have inspected. These flags apply only when a decision checkpoint is active; future child settings stay as originally saved. Child limits and uncertain effects use the child resume controls above. The operation report includes its active decision ID, whose usage record is in the decision checkpoint directory.

For interrupted external effects, inspect the destination and [reconcile the original child](./chief-missions.md#inspect-and-resume) before retrying. Resuming an operation does not resolve uncertainty or reset child budgets. Repeated goal/evidence decisions wait. Malformed decisions, unavailable credentials, corrupted records and mismatched snapshots pause with the cause. Live locks prevent concurrent runners.

Verified changes are carried to the next improvement using private Git snapshots, including uncommitted product changes. The original checkout and index are preserved. Workspaces retain the original delivery remote; publishing, pushing and deployment still need to be within the operating charter and available permissions. Snapshots do not automatically merge into the original branch.

## MCP clients

The AV MCP server exposes `av_operate`, `av_operations`, `av_operation_status`, `av_operation_report`, `av_operation_resume` and `av_operation_cancel`. Submit a charter to `av_operate`; it returns an operation ID immediately. Use a stable `requestId` to deduplicate repeated submissions. Disconnecting the client leaves the detached operation running. Cancellation is asynchronous: poll until the operation is paused and its supervisor has stopped.

Managed Actors cannot recursively start or resume operations. They return their findings to the supervising Chief. Use existing `av_status` and `av_report` with child mission IDs for detailed evidence. Operation resume retains the original charter and settings; CLI `--cycles` can extend a bounded operation.
