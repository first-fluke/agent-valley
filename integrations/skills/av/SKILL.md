---
name: av
description: Delegate a repository goal or continuous improvement charter to Agent Valley's Chief Director and inspect, resume or stop its verified work. Use when the user asks AV to supervise Actors through execution, review and verification.
---

# Agent Valley

Use the configured `av` MCP server for the repository the user selected. The Chief Director owns execution and supervision; report the mission's actual state and evidence.

## Prevent recursive delegation

Before `av_order`, `av_resume` or `av_operation_resume`, check the current process environment for `AGENT_VALLEY_MANAGED_RUN` when the client has a local shell/environment tool. Check only this variable; do not dump the environment or read credentials. If its value is `1`, or your assignment identifies you as an AV Chief Director or Actor, perform your assigned work directly. Do not start or resume another AV mission or operation, or run a nested AV setup.

For web clients without a local environment tool, read `av_missions` from the configured AV server. Its structured `executionContext` must report `managed: false` and `delegationAllowed: true` before delegation. Use its advertised workspace instead of inventing a local repository path. A managed assignment or a local `AGENT_VALLEY_MANAGED_RUN=1` always takes priority over a remote server's context. If neither the local environment nor the server establishes the context, do not delegate until it is established.

## Start the goal

1. Resolve the intended repository from the configured server's `av_missions` workspace, or to an absolute local path when local tools are available. Confirm it matches the user's intended project. Keep the user's goal, deliverables, constraints, and acceptance criteria intact. A request for an explanation or comparison alone does not start a mission.
2. Check `av_operations` and `av_missions` for saved work when the request might continue earlier work. Inspect its corresponding status before deciding to resume. Avoid creating duplicate orders.
3. Before the first `av_order` call, generate and retain an opaque `requestId` together with its exact input. Call it with that ID, `goal`, and, when needed, `workspace`. The default continues selecting verified improvements within that goal. Set `once: true` when the user asks to complete one goal and stop. Supply `verify`, `parallel`, `runs`, `duration`, `cost`, `cycles`, or `interval` only for user-specified overrides; `cycles` and `interval` apply only to continuous work. Retry an uncertain or timed-out submission with the same ID and identical input, including the execution mode. Never introduce a new request ID merely because the original response was lost.
4. Keep the returned `operationId` for default continuous work or `missionId` for `once: true`. An accepted or started order is incomplete. Inspect the corresponding status/report tools at reasonable intervals. Do not resubmit the goal because a long run has not finished.

AV reads the saved repository settings to select the Chief Director and available Actors. Do not invent model availability, measurements, or a successful outcome.

## Continuous improvement

`av_order` uses the user's `goal` as the operating charter unless `once: true` is supplied. Preserve the goal's scope and constraints across improvements. The default continues until stopped or paused and can incur ongoing model charges. Limits apply to each improvement and decision checkpoint, not lifetime operation spending. A user-specified `cycles` bounds cumulative verified improvements. There is one submission tool for both execution modes.

Keep the returned operation ID. Read `av_operation_status(operationId)` and `av_operation_report(operationId)` for progress and decisions. Use `av_status` and `av_report` with its child mission IDs for actual verification and measurements. A running continuous operation is not a completed service improvement merely because submission succeeded.

`av_operation_resume(operationId, requestId?)` preserves the charter and accepted changes. Repair and explicitly resume a paused child before continuing its operation; this call does not reconcile uncertain external effects or reset spent budgets. `av_operation_cancel(operationId)` requests a stop; poll until the operation is paused and the supervisor is stopped before retrying. MCP disconnect alone leaves detached operations running.

Installed tools or configured MCP names do not prove login or service access. Chief Actors can use available tools within existing permissions; missing evidence remains a reported limitation.

## Supervise and report

- `av_missions`: list saved missions for the bound repository.
- `av_status(missionId)`: read progress, current status, and blockers.
- `av_report(missionId)`: read the actual report and its verification evidence.
- `av_resume(missionId, retry?, runs?, duration?, cost?, rounds?, requestId?)`: continue an existing mission. Preserve spent budgets; increase limits only within the user's authorization. Generate and retain a request ID before the first resume call and reuse it with identical input for every retry of that request.
- `av_cancel(missionId)`: cancel when the user asks to stop the mission.

An accepted or `starting` response is incomplete. Reconnecting to MCP does not cancel or restart independently supervised work; inspect its saved operation or mission before choosing a next action. Treat `completed` as success only with the report's verified result. Explain `paused` or `failed` using its recorded reason and the next required action. `waiting`, scheduled observation, planning, or active Actor work is still incomplete. State the operation or mission ID and current status if the client session ends while work remains. A report file or delivery request does not prove that a third-party provider accepted an attachment.

Explain the result in plain language: what changed, how it was checked, remaining work, and material limits. Distinguish observed metrics and token usage from estimates and unknown costs. Link the actual artifacts the report identifies; never claim an upload, deployment, or merge from a planned action.

## Authorization

Starting a mission does not create permission to publish, merge, deploy, contact people, buy services, spend additional money, raise budgets, or change client approval settings. Carry the user's existing authorization and constraints into the goal. Stop at the required approval boundary and explain what needs approval. Do not enable trust or bypass permissions while installing or using this integration.

If AV tools or configuration are missing and the user has requested installation, follow the [agent setup procedure](https://raw.githubusercontent.com/first-fluke/agent-valley/main/AGENT_SETUP.md). The user-facing initiating local agent becomes the Chief Director using its trusted current runtime identity; carry its confirmed active model or explicitly use `--model ''` for the native default when the exact model is unknown. Installer workers preserve the initiating session's vendor/model; an explicit user override takes precedence. Reading that document alone does not authorize installation. Preserve the selected project binding, report login/reload/trust actions that remain, and never start a mission just to check setup. In a managed run, perform the assignment directly and report missing prerequisites instead of starting nested setup. If configuration already exists, follow the reported key/file guidance or repair the project integration within the user's authorization. Do not simulate a mission or silently use another repository.
