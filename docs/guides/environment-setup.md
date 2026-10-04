# Install and operate Agent Valley

## Set up with a local agent

Give your local agent [AGENT_SETUP.md](../../AGENT_SETUP.md) and the target repository. That single document contains the complete installation procedure. The user-facing initiating agent becomes the Chief Director using its trusted runtime identity. It pins the exact active session model only when confirmed; otherwise it passes `--model ''` to clear a stale pin and save the CLI's native default. An installer worker preserves that initiating session's vendor/model. Installed CLIs, OMA configuration, login state, and price do not select the Chief Director.

The agent runs the installer with `--yes --no-workflows --no-setup`, then uses the installed launcher for `av setup --yes --actor <initiator-vendor> --model <confirmed-model-or-empty> --workspace <selected-repo> --oma prepare --json`. The explicit absolute workspace makes the user's selected target take precedence over an existing saved binding. Setup's JSON and exit status distinguish `ready`/0, `action_required`/2, and `failed`/1. Browser/device login, unknown readiness, client reload, and workspace/MCP trust remain explicit pending actions. Stop unattended retries until the reported action is complete; rerun the same command while preserving saved configuration. OMA is deferred only when the user requests `--oma skip`.

This path configures local orders and project MCP without running a mission or starting the dashboard. `av doctor` provides additional human-readable diagnostics; it does not have a `--json` flag. A web-only chat client needs a local agent to perform installation and a separate authenticated server for web MCP access.

## Install and set up local orders

Start in an existing Git repository with at least one commit. Git and curl must be installed:

```bash
cd /absolute/path/to/repo
curl -fsSL https://raw.githubusercontent.com/first-fluke/agent-valley/main/scripts/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
av order "Fix the login failure and add a regression test"
```

The installer prepares Node.js 26.10.0 and Bun 1.4.2 when needed, installs locked dependencies, and creates a source launcher at `~/.local/bin/av`. Remote installations keep the checkout under `~/.local/share/agent-valley`; a local installation uses its existing checkout. There is no build step. In an interactive terminal, installation opens `av setup --mode order`, including when the script arrives through `curl | bash`.

The interactive wizard validates the target Git repository, selects the Chief Director CLI and optional model, guides its CLI installation and login, and uses Chief-designed checks unless you supply a trusted acceptance command. Agent-led setup supplies the current agent's own vendor/model choice through the noninteractive path above. Browser or device sign-in remains interactive. If a CLI cannot report its login state, readiness remains unknown and the result explains the required action. Other ready worker CLIs are discovered automatically; installing every vendor is unnecessary.

The source installer and completed setup also install the project `av` skill and MCP entry for Codex, Claude Code, Cursor, Qwen Code, and Antigravity. Existing client settings, other skills, and user profiles are preserved; conflicting AV names produce an error with recovery instructions. Restart the client and complete its normal workspace/MCP trust step. Run `av integrations install --workspace /absolute/project` to prepare the integration later. See [agent client integration](./agent-clients.md), [native plugins](./native-plugins.md), and [web OAuth](./web-mcp.md).

The wizard also offers OMA installation or update in the selected target repository, with preparation selected by default. It prepares the latest CLI and full skill set while preserving the existing OMA configuration. A failure offers retry or deferral with a recovery command. OMA preparation does not enable strict completion receipts; those require the separately supported CLI version described in [OMA completion evidence](./oma-integration.md).

Preparation downloads the [official OMA installer](https://raw.githubusercontent.com/first-fluke/oh-my-agent/main/cli/install.sh) into a temporary file and runs it to prepare dependencies. It then waits for `bun install --global oh-my-agent@latest` and runs the latest package in the target repository: `install` with `CI=true` for a new harness, or `update --yes --with-new-skills --all` for an existing one. The update includes newly added skills without using `--force`. The wizard checks the installed project metadata and skill files before reporting success. To prepare OMA after deferring it, run `av setup --edit` and select **OMA skills (install/update)**.

Repository and verification settings go in `av.yaml`. The Chief Director defaults go in `~/.config/agent-valley/settings.yaml` as `actor.type` and optional `actor.model`. A blank model selects the CLI default and removes a previous explicit model. Agent-led setup passes that empty value explicitly when it cannot confirm the active session model; a static provider setting alone may have been overridden in the session. Orders honor the saved Chief Director choice; `--actor` and `--model` override it for a single order. See [Chief Director orders](./chief-missions.md) for generated teams and resume behavior.

`av.yaml` is the only project configuration file. Loading, setup, edits, diagnostics, and configuration watching use this filename. Missing or malformed configuration is reported with instructions for fixing `av.yaml`. Legacy `agent:` blocks remain readable inside supported configuration files; within one file, an explicit `actor:` block takes precedence as a whole.

Without `--headless`, `--yes`, `--no-setup`, CI, or a missing interactive terminal defer the wizard and print its command. For example:

```bash
curl -fsSL https://raw.githubusercontent.com/first-fluke/agent-valley/main/scripts/install.sh | bash -s -- --yes --no-workflows
av setup
```

For an unattended installer run, `--headless --actor <initiator-vendor> --model <confirmed-model-or-empty> --oma prepare` forwards to local order setup and propagates its `0`/`2`/`1` exit status. It uses the current invocation project as the target, has no separate target flag, and remains a progress-text interface. Use the canonical two-step path with explicit `--workspace` for a user-selected target; it also supplies the structured report and supports `--verify`. `--headless` and `--no-setup` cannot be combined.

Run `av setup` again to change the local order configuration, or `av setup --edit` for selected fields. Existing unrelated global settings are preserved.

Setup saves project configuration in its invocation directory. To keep configuration and mission history in directory A while Actors work in repository B, invoke setup from A with `--workspace /absolute/repository-B`. Integrations are installed in B and launch `av mcp --workspace A`. When client tools are available, read `av_missions` and check both `project=A` and `workspace=B`. Preserve this binding when rerunning setup; see [agent client project binding](./agent-clients.md).

## Set up tracker automation

Use the source checkout for the dashboard and tracker runtime:

```bash
git clone https://github.com/first-fluke/agent-valley.git
cd agent-valley
bun install --frozen-lockfile
bun av setup --mode tracker
bun av doctor
bun av up --dev
bun av status
```

Run these commands from the Agent Valley checkout. The CLI needs the dashboard source in `apps/dashboard`; a standalone CLI package does not include a dashboard runtime. Keep this checkout separate from the target repository when possible. Set `workspace.root` to an existing absolute Git repository path with at least one commit. It is not an empty scratch directory. Each issue gets a worktree under that repository.

Use `bun av dev` for foreground logs and configuration watching, or `bun av up --dev` for a background process without a production build. Plain `bun av up` attempts a production dashboard build before starting.

Supported actor values are `claude`, `codex`, `qwen`, `antigravity`, `cursor`, `grok`, `kimi`, and `opencode`. Antigravity uses the `agy` executable. The wizard guides preparation of the selected CLI.

Tracker mode selects Linear or GitHub, the actor, workspace, tunnel, and completion checks, and offers the same OMA preparation. It writes project configuration to `av.yaml` and user defaults/credentials to `~/.config/agent-valley/settings.yaml`. Project values override global values; existing unrelated global settings are preserved. The example YAML is a reference, not a ready-to-run configuration. OMA preparation can be deferred.

For a first run, use `actor.max_parallel: 1` and `delivery.mode: pr`. Authenticate the chosen CLI before starting Agent Valley. PR delivery requires authenticated `gh`; the target repository needs a usable remote. Increase concurrency after one small task passes verification and creates its PR.

## Completion checks

Code tasks require `verify.command` in `av.yaml`. Use the target repository's deterministic test/typecheck commands, including dependency installation when a new worktree needs it. For example, for this repository:

```yaml
verify:
  command: bun install --frozen-lockfile && bun run typecheck && bun run test
  timeout_sec: 600
```

The check runs in the issue worktree before delivery. A failed check retries with its output attached; exhausted retries cancel the issue. A zero actor exit code alone does not mark a code task Done. If the work is a report, select analysis and an attempt-specific report path instead:

```yaml
task:
  kind: analysis
  report_path: .agents/results/analysis-{{attempt.id}}.md
```

## Connect a tracker

`bun av dev` prints the local dashboard URL and the tunnel URL. The dashboard uses `server.port` from YAML (default 9741); `SERVER_PORT` overrides it. The public tunnel forwards webhook endpoints only.

| Tracker | Webhook path | Configuration |
|---|---|---|
| Linear | `/api/webhook` | Team/API key and Todo/In Progress/Done/Cancelled state IDs. The CLI attempts webhook registration after tunnel startup. Resolve a registration error before relying on incoming issues. |
| GitHub | `/api/webhook/github` | Owner, repository, `github.token_env`, signing secret and state labels. Export the named token environment variable. Register an Issues webhook with JSON payloads; use `github.webhook_secret` from `av.yaml`. |

The default tunnel provider is ngrok. The wizard can select Cloudflare or `none`; install the selected tunnel executable. With `none`, provide your own webhook ingress. Existing runnable issues are reconciled at startup, but new changes still need webhook delivery while the runtime is running.

## First task and daily operation

1. Start with `bun av dev` and open the printed local dashboard URL. Check `bun av status`; `/api/health` returns 503 if initialization failed or the runtime stopped.
2. Create a small task with an observable expected result: `bun av issue "Add a unit test for the parser's empty input" --raw --yes`. `--raw` avoids using Claude to expand the description.
3. Confirm the task moves through queued/running, verification, and delivery. Use the operations panel for dependency blockers and retry reasons/times; use `bun av logs` for daemon logs.
4. Inspect the delivered branch/PR and the tracker completion comment before adding more work.
5. For background operation, stop the foreground runtime, then run `bun av up --dev`. It waits for dashboard health before reporting success. `bun av down` stops the daemon; `bun av dev` stops with Ctrl-C.
6. After configuration or CLI authentication changes, restart and run `bun av doctor` again.

`--parent`, `--blocked-by`, and `--breakdown` are Linear features. GitHub issue creation supports plain issues and labels, and rejects unsupported dependency/decomposition flags. Linear decomposition stages tasks in Backlog, attaches dependencies, then publishes the leaves. Do not manually move an incomplete draft batch to Todo until its relationships are correct.

## Troubleshooting

| Symptom | Check and action |
|---|---|
| `av up` exits or never becomes healthy | Read `.av.log` in the Agent Valley checkout. Run `bun av doctor`; check dashboard dependencies, port conflicts, and required configuration. |
| Actor never starts | Check operations-panel blockers/retry time, concurrency, budget limits, selected actor executable/authentication, and webhook delivery in the tracker. |
| Task retries after producing code | Read the verification/delivery error. Run the configured check in the retained worktree; check Git remote and `gh` authentication. |
| Process exits without a result | Run the actor interactively once to authenticate and confirm its installed version. Update incompatible CLIs. The task fails promptly instead of waiting for the full task timeout. |
| Dashboard says unavailable | Run `bun av doctor` and inspect `.av.log` or the foreground output for the initialization failure. Fix it and restart. A connected SSE socket does not imply a healthy scheduler. |
| Runtime restarted while an actor was alive | Recovery reserves that task until the old process exits, then retries retained work. Inspect a stuck process before terminating it. |
| Read-only user cannot control actors | Sign in separately for controls with the intervention token. Viewing status does not require that token. |

Run `bun run test`, `bun run typecheck`, `bun run lint`, and `./scripts/harness/validate.sh` for repository checks. `validate.sh` checks source safety, architecture and coverage; `av doctor` checks runtime configuration and prerequisites. Use `bun run test` for the Vitest suite; bare `bun test` selects Bun's different test runner.

## Optional instruction harness

`scripts/install.sh` also copies actor instructions and documentation into the target project. Review those conventions, especially before accepting the optional repository-specific CI workflows.

```bash
cd your-existing-project
curl -fsSL https://raw.githubusercontent.com/first-fluke/agent-valley/main/scripts/install.sh | bash
# Without an interactive terminal:
# curl ... | bash -s -- --yes --no-workflows --no-setup
```

Running the installer inside its own checkout leaves existing files intact. Repeated installs deduplicate the Symphony section and ignore entries.

## Dashboard and webhook access

`av up`, `av dev`, and the dashboard's direct `dev`/`start` scripts bind
the dashboard to `127.0.0.1` by default. The tunnel points to a separate
loopback listener (port `SERVER_PORT + 1`) that forwards only POST
`/api/webhook` and POST `/api/webhook/github`. Control routes and the UI
are unavailable through that tunnel.

Without configured access tokens, local dashboard requests are accepted.
If a token is configured, its scope requires authentication even on localhost.
Remote dashboard access also needs a reachable bind address and these settings:

| Env var | Effect |
|---|---|
| `SYMPHONY_DASHBOARD_TOKEN=<token>` | Require a bearer token or browser sign-in for status, events, metrics and team data, including local requests. CLI status/top send the token from their environment. |
| `SYMPHONY_ALLOW_REMOTE_STATUS=1` | Requires `SYMPHONY_DASHBOARD_TOKEN` even for local requests; without it, every request is rejected. |
| `SYMPHONY_INTERVENTION_TOKEN=<token>` | Require a bearer token or browser session for all intervention requests. A valid token authorizes local or remote requests without a remote flag. Use a separate token from the status token. |
| `SYMPHONY_ALLOW_REMOTE_INTERVENTION=1` | Requires a configured intervention token; without it, every intervention request is rejected. This flag alone does not grant access. |
| `SYMPHONY_DASHBOARD_HOST=<host>` | CLI-managed dashboard bind address. Non-loopback values require both dashboard and intervention tokens. |
| `SYMPHONY_WEBHOOK_PORT=<port>` | Override the webhook-only listener port; default is `SERVER_PORT + 1`. Point any named tunnel at this port. |

`/api/intervention` controls pause/resume/append_prompt/abort on a live run.
With `SYMPHONY_INTERVENTION_TOKEN` set, matching credentials authorize requests
without requiring `SYMPHONY_ALLOW_REMOTE_INTERVENTION`. With neither set,
only local requests are accepted. The browser signs in with configured
tokens at the dashboard and receives short-lived HttpOnly, SameSite cookies.
Browser mutation requests must include a matching `Origin` header. Do not
place shared secrets in `NEXT_PUBLIC_*` variables.

`/api/webhook` and `/api/webhook/github` verify tracker signatures after
the webhook-only listener forwards them.

## Team dashboard

Team mode needs `team.supabase_url`, `team.supabase_anon_key`, and
`team.id` in `av.yaml` or `~/.config/agent-valley/settings.yaml`.
Run `av login` on the dashboard machine and restart the dashboard. The
dashboard reads the saved user session on the server and queries Supabase with
that user's access token, so the `team_members` and `ledger_events` RLS
policies must allow that user to read the configured team. The browser receives
only the replayed team state through `/api/team/ledger`; it never receives the
Supabase access token or anon key.

Apply `supabase/migrations/002_team_rls_identity.sql` after the initial team
dashboard migration for existing databases. It removes recursive membership
reads and requires new ledger event node IDs to start with the authenticated
user UUID, followed by `:` and a nonempty machine name. `team_members.display_name`
is for display only and does not grant node ownership. Existing username-prefixed
events remain readable, but older running publishers cannot add new events until
they restart with the updated node ID generator. The migration is not applied
automatically by the dashboard. To exercise the policies against synthetic data
in an isolated local PostgreSQL cluster, run
`bash supabase/tests/run-team-rls-local.sh`; it exits 77 when no local server
binary is installed.

When team mode is absent, the dashboard shows the local orchestrator. A missing,
expired, or mismatched `av login` session, denied membership, or upstream error
keeps the local view visible and displays the cause. `av login` does not
refresh a running dashboard's ledger publisher; restart after logging in again.
