# Chief Director orders

See [operations, organization evidence and report attachments](./chief-integrations.md) for measured routing, cross-vendor review, business targets, replaceable channels and Aside capture.

`av order` gives a local Chief Director responsibility for a goal. The Chief Director interprets the request, records assumptions and observable success criteria, creates executable verification checks, and supervises its team. It reviews evidence and chooses repairs, reassignment, or a revised plan when work fails. The application preserves those decisions and enforces independent reviews and the saved acceptance contract.

The default interaction is to provide a goal and receive a report of the Chief Director's decisions and results. Routine choices about skills, personas, available Actor CLIs, task order, implementation, refactoring, and recovery belong to the Chief Director within the user's goal and available permissions. The user's selected Chief Director vendor/model and acceptance criteria remain fixed; explicit model pins in a supplied Actor roster are also preserved. The report explains what it decided, why, what actually happened, and the evidence for the outcome. Missing access, required authentication, or an unresolved blocker remains visible in the report and saved state.

Service improvement, refactoring, usability, and revenue experiments use the installed OMA skills and Director personas relevant to the goal. The Chief Director repeats work, review, repair, and measurement within the order's saved limits. Once the goal passes verification, the order finishes. Use [continuous operation](./chief-continuous.md) with `av operate` to let the Chief select successive improvement goals from accepted code, reports and observed outcomes.

> **Token usage warning:** AV prioritizes your goal over token savings. Planning, persona consultation, Actor execution, independent review, repairs, and replanning can consume substantial model usage and incur API charges. AV does not check or manage your subscription's remaining allowance. Chief orders have no token-count ceiling; reported usage supports routing and reporting. `--cost` is an optional configured-price estimate limit, while call, duration, and recovery limits still apply. Cost-aware routing and the Technical Director's efficiency advice inform the Chief Director's execution decisions.

The Chief Director prioritizes the user's benefit and profit, chooses its own methods, and explores unconventional opportunities and gray areas rather than discarding them by default. It owns execution decisions, supervision, and the account of what happened. The user retains operational responsibility for the goal and the resulting actions. Available environment permissions and the user's goal define the scope of execution. Profit or ROI claims still need evidence; unknown outcomes remain assumptions.

## Start an order

Run the installer from your target repository, or use `bun av setup` from a source checkout. The default wizard checks the repository, prepares the chosen Chief Director CLI and the latest OMA skills, and saves its vendor/model and any configured acceptance command. OMA preparation runs in the selected repository and can be deferred. The repository must have a commit. After setup, run from the directory containing `av.yaml`:

```bash
av order "Fix the login failure and add a regression test"
```

You can also supply the repository and acceptance check directly:

```bash
bun av order "Fix the login failure and add a regression test" \
  --workspace /absolute/path/to/repo \
  --verify 'bun run test'
```

`--verify` is optional. Without it or a saved `verify.command`, the Chief Director creates executable checks for every success criterion. They inspect actual regular files, literal contents, JSON values, or explicit test files with fixed argv. Supported commands are read-only Git checks, `node --test`, `bun test`, and the installed Vitest launcher in run mode. Generated checks cannot invoke shells, package scripts, builds, installation, or publishing. The contract is hashed and retained across repairs and resume; a text claim cannot substitute for the observations.

An explicit `--verify` or saved `verify.command` uses your trusted acceptance command and remains immutable. Replace `bun run test` with commands that exist in the target repository. Prepare dependencies before execution, or include preparation in a trusted command when you intend it. `workspace.root` provides the repository default. A tracker, webhook tunnel, dashboard, or running daemon is not required. `av setup` defaults to local orders; use `av setup --mode tracker` for Linear/GitHub automation. There is no `av init` command.

Without `--actors`, the Chief Director creates 4–8 actors suited to the goal and repository, including its permanent Technical Director, Design Director, and Marketing Director counterparts. Agent Valley discovers installed, authenticated supported CLIs. The saved Chief Director choice is retained, and actors can use the Chief Director CLI or other ready CLIs, each with its native default model.

Before planning, the Technical Director advises on the lowest adequate total cost, execution efficiency, stack standardization, dependency management, reuse, and maintainability. The Design Director advises on usability, divergence and convergence, user personas and field tests, short journeys, intuition, and visibility. She enjoys using dark patterns for retention and evaluates them with conversion, churn, and usability data. The Marketing Director is a maniacal profit fanatic who cannot sleep when ROI drops. He treats wasted money and lost conversions as personal failures, relentlessly pressures contributors for measurable gains, and hunts revenue through known channels, unknown indirect routes, and gray opportunities. When one route stalls, he pushes another experiment until measurable profit improves. Actual observations, simulations, and untested hypotheses are reported separately. These are advisory roles: the Chief Director makes the business tradeoffs, including higher costs when justified by the goal or expected profit. A negative advisory review does not veto execution or determine completion.

Supported CLIs are `claude`, `codex`, `qwen`, `antigravity`, `cursor`, `grok`, `kimi`, and `opencode`. `--actor` and `--model` override only the Chief Director for one order. Omit them to use saved `actor.type` and its matching `actor.model`; without a saved model, the CLI default is used. A model from one vendor is not reused when you choose another vendor. Worker discovery still runs. A saved or explicit Chief Director is kept even when local readiness checks cannot confirm it; missing installation or authentication is reported when the CLI starts.

`--actors` uses your custom team; readiness discovery still establishes available review CLIs. The default director IDs are `chief-director`, `technical-director`, `design-director`, and `marketing-director`. Existing legacy `chief`, `cto`, `cdo`, and `cmo` IDs are retained where supplied, so renaming does not duplicate directors or reset a saved order. Missing advisory roles are added using the Chief Director's CLI and its native default model. `--actor` and `--model` can override that team's Chief Director without changing configured actors. Use a custom team to specify actor models or skill assignments. Automatic teams select relevant installed skills from the target repository's verified OMA catalog.

The CLI prints an order ID, its worktree, and a resume command. By default, a foreground supervisor starts a child worker, restarts it after a crash within the saved retry budget, and resumes scheduled provider retries or metric observations. `--no-supervise` runs directly without that restart and polling loop. If the supervisor or machine stops, `av missions --watch` can continue eligible orders from their saved checkpoints.

Foreground `av order` exits with `0` for a verified completed order, `1` for a failed order or process/report error, and `2` for an unresolved order, including pause, waiting, and operator interruption. Its output includes the state, reason, and resume command. A scheduled waiting order remains inside the supervisor's polling loop; a direct run returns `2`. Paused or failed orders need `av order --resume ORDER_ID --retry` after their blocker is addressed. Queue submission acknowledges acceptance separately from completion.

`--timeout <seconds>` bounds each Actor or check; the default is `actor.timeout` from configuration, otherwise 600 seconds. `--repairs <count>` controls local task and final-review repairs; the default is 2. Exhausting those repairs returns the problem to the Chief Director. `--rounds <count>` bounds Chief Director recovery decisions, with a default of 8 and a maximum of 50. Three recovery rounds without changed worktree, metric, or external-effect evidence stop the order as incomplete. Bounds and decisions survive resume.

New orders default to 200 Actor calls, 86,400 seconds of elapsed mission time, and three concurrent Actors. Set `--runs`, `--duration`, and `--parallel` or configure `chief.execution` in `av.yaml`. Time includes waiting and restarts. `--cost <usd>` limits the total estimate using configured model prices and reported usage; unknown cost pauses further calls. These estimates do not impose an exact billing cap on in-flight calls or subscription plans. The report retains spent calls, time, known cost, and unknown observations.

## Plan, review, and completion

The Chief Director consults its Technical Director, Design Director, and Marketing Director concurrently, then turns even a broad request, such as “make onboarding easier,” into a concrete interpretation, assumptions, success criteria, and verification checks. It plans at most 12 tasks with acceptance criteria and acyclic dependencies. Up to three independent Actors run in separate task worktrees by default; dependencies wait for reviewed and integrated prerequisites. The Chief Director integrates accepted changes, and conflicting changes return to repair. `--parallel 1` preserves serial execution in the mission worktree. A different Actor reviews each task. Advisory, planning, supervision, review, and reporting stages must leave product files unchanged.

The Chief Director can repair a failed task, assign it to another configured Actor, revise the task plan, or stop with an explained blocker. Replanning must retain the original acceptance obligations. It cannot replace the user's goal, weaken the saved success criteria or executable checks, switch the operator's Chief Director vendor/model, or change a supplied verification command. Recovery rounds are recorded before dispatch, so restarting does not reset them. Authentication and environment failures pause for repair; rate limits and provider outages receive bounded delayed retries.

After task reviews and integration pass, the saved executable checks or trusted acceptance command run in the mission worktree. File and test inputs and command output receive SHA-256 evidence bindings. The Chief Director then assesses the complete result against the saved success criteria. Completion requires passing task reviews, passing verification, final approval, and a changed code or report artifact. A successful CLI exit or a text promise alone is insufficient. Hitting a limit or encountering a blocker leaves the goal incomplete.

Configured business targets can collect actual observations from Stripe captured-charge revenue less refunds, an HTTP JSON endpoint, or a repository JSON file. Sources and credentials must be configured by the user; missing or invalid observations are not fabricated. Orders wait during the observation window and poll saved sources, then return unmet outcomes to the Chief Director. A waiting order is incomplete. See [business metric sources](./chief-integrations.md) for source configuration and measurement limits.

Every new order saves a Markdown report at `.agent-valley/reports/ORDER_ID.md` in the directory where it was started. It includes an ELI5 explanation, the goal and assumptions, Chief Director decisions, Technical Director/Design Director/Marketing Director advice, assigned CLIs/models/skills, deliverables, recorded checks, and remaining issues. Failed orders also receive a report. If the Chief Director cannot generate one, the application writes a report from saved evidence. An explanation does not bypass completion gates. This execution report is stored outside the product worktree and does not satisfy the material-deliverable requirement.

The order leaves its branch and worktree for inspection. The scheduler does not automatically publish, push, merge, or create a PR. A worker may perform delivery when the operator explicitly includes it in the goal and the environment permits it; the plan must include its verification and record actual delivery evidence. Tracker-driven `av up`/`av dev` delivery settings do not enable delivery for local orders.

## Named actors

To supply your own names, roles, CLIs, models, and selected skills, create a YAML file:

```yaml
director: nora
actors:
  - id: nora
    name: Nora
    role: Own the goal, plan tasks, review evidence, and request repairs.
    actorType: codex
    skills: []
  - id: mina
    name: Mina
    role: Research primary sources and write a cited report.
    actorType: claude
    skills: []
  - id: jun
    name: Jun
    role: Implement changes and regression tests using the project's conventions.
    actorType: codex
    skills: []
```

```bash
bun av order "Investigate and fix intermittent sign-in failures" \
  --workspace /absolute/path/to/repo \
  --verify 'bun run test' \
  --actors ./actors.yaml
```

Every actor needs a unique `id`, a `name`, a `role`, an `actorType`, and a `skills` array. `model` is optional and must name a model accepted by that actor's CLI. The roster needs at least two actors so execution has an independent reviewer. `director` names an existing actor; `--director <id>` overrides that selection.

Legacy `chief`, `personas`, and `agentType` profile fields and the `--chief`, `--personas`, and `--agent` flags remain readable aliases. New examples and CLI help use Director and Actor names. Mission storage preserves existing identifiers so previously saved orders can resume.

Skill names refer to `.agents/skills/<name>/SKILL.md` inside the target worktree. Keep `skills: []` when no installed skill is needed. Explicitly listed skills are loaded whether or not receipt enforcement is enabled.

## OMA integration

`av setup` prepares the latest OMA CLI and skills by default. The Chief Director can select installed skills without enabling receipt enforcement. To require receipts with `--oma`, install the separately supported OMA CLI version and ensure the target repository's trigger table, workflow files, and selected skills are present in its worktree. Then run:

```bash
bun av order "Fix the login failure and add a regression test" \
  --workspace /absolute/path/to/repo \
  --verify 'bun run test' \
  --actor codex \
  --oma
```

Installed `.agents/skills/oma-*/SKILL.md` files are discovered for every new order. Missing installed skill files and their resources are copied into the isolated worktree without overwriting its existing files, so a freshly installed harness does not require a commit before an order. The Chief Director receives skill names, descriptions, and verified paths and selects only relevant skills for its team. The catalog includes new skills as they are installed, without a fixed allowlist of skill names. For example, market, search, architecture, or design can be selected when present. Video and explainer can be selected if installed; missing skills are not invented. ELI5 reporting remains available without an explainer skill. Only selected instruction bodies are loaded. Resume checks saved skill paths and metadata again. Skills that need external tools, credentials, or services still require those dependencies.

`--oma` additionally requires current OMA completion receipts for worker stages; skill selection does not require that flag. Each receipt uses `git diff --check <task-start-HEAD> --` for patch whitespace and conflict markers, with the starting commit fixed by the runtime. This checks the worker's changes even after committing. Workers also run checks relevant to their assignment and report the results for independent review. They commit changes before OMA verification and finish the exact run they started.

The receipt gate does not check language syntax or prove that the feature works. Final executable checks or the operator's `--verify` command run after reviewed task changes have been integrated, so intermediate tasks can finish before the whole goal is implemented. Completion still requires final verification and the Chief Director's approval. The flag is explicit for each new order; `oma.mode` in tracker configuration does not enable it automatically.

See [OMA completion evidence](./oma-integration.md) for the supported CLI version, `--project-root` contract, and receipt validation. Missing tools, skills, checks, or stale evidence fail the order with a recorded error.

## Research output

A research order needs a file deliverable and checks that match its intended contents. The Chief Director can design those checks, or you can provide a trusted command. For example:

```bash
bun av order "Compare the repository's queue design with two alternatives. Write reports/queue-review.md with sources, tradeoffs, and a recommendation." \
  --workspace /absolute/path/to/repo \
  --verify 'test -s reports/queue-review.md'
```

The check confirms that the report exists and is nonempty. The reviewer and Chief Director must assess its content and sources. Use an ordinary product path as in this example; order fingerprints exclude `.agents/results`, `.agents/state`, and `.agent-valley`. Tracker analysis tasks have a separate attempt-specific report contract described in the [setup guide](./environment-setup.md#completion-checks).

## Inspect and resume

```bash
bun av missions
bun av order --resume ORDER_ID
bun av missions --watch
```

Use the ID printed by `av order`, and run these commands from the same directory where you started it. Mission records live under `.agent-valley/missions/` there. They contain the goal, success criteria, assumptions, roster, plan, task attempts, review findings, verification output, recovery decisions, report, and history. Automatic orders also save the available CLI list and skill catalog. Worktrees remain available after completion or failure.

Ctrl-C or SIGTERM interrupts the current order and retains its state. Resume uses the saved goal, criteria, Actors, Chief Director CLI and model, available CLI list, workspace, verification contract, and spent repair/recovery budgets without rediscovering CLIs or resetting the plan. A pending Chief Director decision is retried before workers restart. A new goal or verification contract requires a new order. A live order is locked against a second resume process. If files changed since the checkpoint, previous approvals are invalidated and tasks are reviewed again. Older saved orders retain their original command and serial repair behavior.

After fixing authentication, environment, or provider problems, use `--resume ORDER_ID --retry`. Resume may increase `--runs`, `--duration`, `--cost`, and `--rounds`; it cannot reduce limits or reset prior spending. For example:

```bash
av order --resume ORDER_ID --retry --runs 400 --duration 172800 --rounds 12
```

External tasks record that execution started before dispatch. If a crash or interruption leaves their outcome uncertain, the order pauses instead of repeating the action. Inspect the actual destination, then record whether the action completed or was not applied:

```bash
av order --resume ORDER_ID --resolve-effect TASK_ID --effect-result completed --retry
# Or, only after confirming that the destination was unchanged:
av order --resume ORDER_ID --resolve-effect TASK_ID --effect-result not-applied --retry
```

`completed` preserves the external action and proceeds to evidence review; `not-applied` permits another attempt. This checkpoint applies to tasks identified as external effects. Native Actor CLIs can use their own tools, so AV cannot guarantee exactly-once execution for every external tool call.

After a hard crash, resume checks recorded Actor and verification process groups. A proven orphan owned by a dead coordinator is stopped before execution resumes. An uncertain PID, live owner, or incomplete cleanup remains blocked for inspection. If the crash occurred before a PID could be saved, the error names the process marker to inspect after stopping any remaining worker. A changed branch or broken Git workspace must be restored before continuing.

When an order fails, inspect its recorded error and retained worktree before resuming. Authentication failures need a working actor CLI login. Restore missing selected skill files inside the retained worktree; changing the original repository or actor profile does not update a saved order. Address verification failures using the recorded test output. Resume does not promise that an exhausted or unfixable order will complete.
