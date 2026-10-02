# Chief orders

`av order` gives a local chief a goal. The chief creates a plan, assigns tasks to named personas, reviews their output, requests repairs, and runs the operator's acceptance check. Its plan and results survive process restarts.

## Start an order

Run from an installed Agent Valley source checkout with an authenticated agent CLI on PATH. The target must be an existing Git repository with a commit. Supply an absolute repository path and a verification command that works inside a new worktree:

```bash
bun av order "Fix the login failure and add a regression test" \
  --workspace /absolute/path/to/repo \
  --verify 'bun run test' \
  --agent codex
```

Replace `bun run test` with the target repository's acceptance check. Include dependency installation if its worktrees require it, for example `bun install --frozen-lockfile && bun run typecheck && bun run test` for Agent Valley itself. The command is required for every order. If `valley.yaml` exists, `workspace.root` and `verify.command` provide defaults; explicit options override them. A tracker, webhook tunnel, and dashboard are not required for orders.

Supported `--agent` values are `claude`, `codex`, `antigravity`, `cursor`, `grok`, `kimi`, and `opencode`. This sets the default roster's CLI. A custom roster selects `agentType` separately for each persona.

The CLI prints an order ID, its worktree, and a resume command. Work runs in the foreground. `--timeout <seconds>` bounds each agent or check; the default is `agent.timeout` from configuration, otherwise 600 seconds. `--repairs <count>` bounds task and final-review repair rounds; the default is 2.

## Plan, review, and completion

The chief plans at most 12 tasks with acceptance criteria and acyclic dependencies. Specialists execute sequentially in one isolated worktree. A different persona reviews each task: the `reviewer` persona when available, then the chief, then another persona. Rejected work returns to its worker within the repair limit. Planning and review stages must leave product files unchanged.

After task reviews pass, the acceptance command runs in the worktree. The chief then reviews the complete result. Completion requires passing task reviews, a passing command, final approval, and a changed code or report artifact. A successful CLI exit or a text promise alone is insufficient.

This is a local coordinator with bounded retries. It does not automatically merge, push, create a PR, send messages, or run as a cloud daemon. The returned branch and worktree are the deliverable. Inspect them and use your repository's normal delivery process. Tracker-driven `av up`/`av dev` delivery settings do not change this behavior.

## Named personas

The default roster contains `chief`, `researcher`, `engineer`, `backend`, `frontend`, and `reviewer`. To supply names, roles, models, and selected skills, create a YAML file:

```yaml
chief: nora
personas:
  - id: nora
    name: Nora
    role: Own the goal, plan tasks, review evidence, and request repairs.
    agentType: codex
    skills: []
  - id: mina
    name: Mina
    role: Research primary sources and write a cited report.
    agentType: claude
    skills: []
  - id: jun
    name: Jun
    role: Implement changes and regression tests using the project's conventions.
    agentType: codex
    skills: []
```

```bash
bun av order "Investigate and fix intermittent sign-in failures" \
  --workspace /absolute/path/to/repo \
  --verify 'bun run test' \
  --personas ./personas.yaml
```

Every persona needs a unique `id`, a `name`, a `role`, an `agentType`, and a `skills` array. `model` is optional and must name a model accepted by that persona's CLI. The roster needs at least two personas so a worker has an independent reviewer. `chief` names an existing persona; `--chief <id>` overrides that selection.

Skill names refer to `.agents/skills/<name>/SKILL.md` inside the target worktree. Keep `skills: []` when no installed skill is needed. Explicitly listed skills are loaded whether or not receipt enforcement is enabled.

## OMA integration

Install the supported OMA CLI and ensure the target repository's OMA trigger table, workflow files, and selected skills are present in its worktree. Then run:

```bash
bun av order "Fix the login failure and add a regression test" \
  --workspace /absolute/path/to/repo \
  --verify 'bun run test' \
  --agent codex \
  --oma
```

`--oma` attaches selected OMA skills to the default specialist roster and requires current OMA completion receipts for worker stages. Each receipt uses `git diff --check <task-start-HEAD> --` for patch whitespace and conflict markers, with the starting commit fixed by the runtime. This checks the worker's changes even after committing. Workers also run checks relevant to their assignment and report the results for independent review. They commit changes before OMA verification and finish the exact run they started.

The receipt gate does not check language syntax or prove that the feature works. The operator's `--verify` command runs after all tasks have passed review, so intermediate tasks can finish before the whole goal is implemented. Completion still requires that final command and the chief's approval. The flag is explicit for each new order; `oma.mode` in tracker configuration does not enable it automatically.

See [OMA completion evidence](./oma-integration.md) for the supported CLI version, `--project-root` contract, and receipt validation. Missing tools, skills, checks, or stale evidence fail the order with a recorded error.

## Research output

A research order still needs a file deliverable and an acceptance command. For example:

```bash
bun av order "Compare the repository's queue design with two alternatives. Write reports/queue-review.md with sources, tradeoffs, and a recommendation." \
  --workspace /absolute/path/to/repo \
  --verify 'test -s reports/queue-review.md' \
  --agent codex
```

The check confirms that the report exists and is nonempty. The reviewer and chief must assess its content and sources. Use an ordinary product path such as `reports/queue-review.md`; order fingerprints exclude `.agents/results`, `.agents/state`, and `.agent-valley`. Tracker analysis tasks have a separate attempt-specific report contract described in the [setup guide](./environment-setup.md#completion-checks).

## Inspect and resume

```bash
bun av missions
bun av order --resume ORDER_ID
```

Use the ID printed by `av order`, and run these commands from the same Agent Valley directory. Mission records live under `.agent-valley/missions/` there. They contain the goal, roster, plan, task attempts, review findings, verification output, and history. Worktrees remain available after completion or failure.

Ctrl-C or SIGTERM interrupts the current order and retains its state. Resume uses the saved goal, personas, workspace, acceptance command, and repair counters. Pass only `--resume ORDER_ID`; a new goal or changed options requires a new order. A live order is locked against a second resume process. If files changed since the checkpoint, previous approvals are invalidated and tasks are reviewed again.

After a hard crash, resume also checks the recorded worker or verification process group. It refuses to start another worker while the previous group is alive. If the crash occurred before a PID could be saved, the error names the process marker to inspect after stopping any remaining worker. A changed branch or broken Git workspace must be restored before continuing.

When an order fails, inspect its recorded error and retained worktree before resuming. Authentication failures need a working agent login. Restore missing selected skill files inside the retained worktree; changing the original repository or persona file does not update a saved order. Address verification failures using the recorded test output. Resume does not promise that an exhausted or unfixable order will complete.
