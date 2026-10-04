---
name: av
description: Delegate a repository goal to Agent Valley's Chief Director, inspect saved missions and evidence reports, or resume or cancel an AV mission. Use when the user asks AV or the Chief Director to own a goal through planning, Actor work, independent review, and verification.
---

# Agent Valley

Use the configured `av` MCP server for the repository the user selected. The Chief Director owns execution and supervision; report the mission's actual state and evidence.

## Prevent recursive delegation

Before `av_order` or `av_resume`, check the current process environment for `AGENT_VALLEY_MANAGED_RUN` when the client has a local shell/environment tool. Check only this variable; do not dump the environment or read credentials. If its value is `1`, or your assignment identifies you as an AV Chief Director or Actor, perform your assigned work directly and do not start or resume another AV mission.

For web clients without a local environment tool, read `av_missions` from the configured AV server. Its structured `executionContext` must report `managed: false` and `delegationAllowed: true` before delegation. Use its advertised workspace instead of inventing a local repository path. A managed assignment or a local `AGENT_VALLEY_MANAGED_RUN=1` always takes priority over a remote server's context. If neither the local environment nor the server establishes the context, do not delegate until it is established.

## Start the goal

1. Resolve the intended repository from the configured server's `av_missions` workspace, or to an absolute local path when local tools are available. Confirm it matches the user's intended project. Keep the user's goal, deliverables, constraints, and acceptance criteria intact. A request for an explanation or comparison alone does not start a mission.
2. Check `av_missions` for an existing mission when the request might continue earlier work. Use `av_status(missionId)` to inspect it before deciding to resume. Avoid creating duplicate orders.
3. Before the first `av_order` call, generate and retain an opaque `requestId` together with its exact input. Call it with that ID, `goal`, and, when needed, `workspace`. Supply `verify`, `parallel`, `runs`, `duration`, or `cost` only for user-specified overrides. Retry an uncertain or timed-out submission with the same ID and identical input; inspect missions before resubmitting. Never introduce a new request ID merely because the original response was lost.
4. Keep the returned mission ID. An accepted or started order is incomplete. Inspect `av_status` at reasonable intervals and read `av_report` when a report is available. Do not resubmit the goal because a long run has not finished.

AV reads the saved repository settings to select the Chief Director and available Actors. Do not invent model availability, measurements, or a successful outcome.

## Supervise and report

- `av_missions`: list saved missions for the bound repository.
- `av_status(missionId)`: read progress, current status, and blockers.
- `av_report(missionId)`: read the actual report and its verification evidence.
- `av_resume(missionId, retry?, runs?, duration?, cost?, rounds?, requestId?)`: continue an existing mission. Preserve spent budgets; increase limits only within the user's authorization. Generate and retain a request ID before the first resume call and reuse it with identical input for every retry of that request.
- `av_cancel(missionId)`: cancel when the user asks to stop the mission.

An accepted or `starting` response is incomplete. Reconnecting to MCP does not cancel or restart the independently supervised mission; inspect the saved mission before choosing a next action. Treat `completed` as success only with the report's verified result. Explain `paused` or `failed` using its recorded reason and the next required action. `waiting`, scheduled observation, planning, or active Actor work is still incomplete. State the mission ID and current status if the client session ends before completion. A report file or delivery request does not prove that a third-party provider accepted an attachment.

Explain the result in plain language: what changed, how it was checked, remaining work, and material limits. Distinguish observed metrics and token usage from estimates and unknown costs. Link the actual artifacts the report identifies; never claim an upload, deployment, or merge from a planned action.

## Authorization

Starting a mission does not create permission to publish, merge, deploy, contact people, buy services, spend additional money, raise budgets, or change client approval settings. Carry the user's existing authorization and constraints into the goal. Stop at the required approval boundary and explain what needs approval. Do not enable trust or bypass permissions while installing or using this integration.

If the `av` tools are missing, run `av integrations install --workspace /absolute/project` only when installation is within the request, then restart or reload the client and complete its normal workspace/MCP trust step. If AV configuration is missing, follow the reported key/file guidance or run `av setup` when authorized. Do not replace AV with a simulated mission or silently launch a different repository.
