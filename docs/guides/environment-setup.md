# Install and operate Agent Valley

## Install the runtime

Use a source checkout with Bun, Git, and an authenticated supported agent CLI on PATH:

```bash
git clone https://github.com/first-fluke/agent-valley.git
cd agent-valley
bun install --frozen-lockfile
bun av setup
bun av doctor
bun av up --dev
bun av status
```

Run these commands from the Agent Valley checkout. The CLI needs the dashboard source in `apps/dashboard`; a standalone CLI package does not include a dashboard runtime. Keep this checkout separate from the target repository when possible. Set `workspace.root` to an existing absolute Git repository path with at least one commit. It is not an empty scratch directory. Each issue gets a worktree under that repository.

Use `bun av dev` for foreground logs and configuration watching, or `bun av up --dev` for a background process without a production build. Plain `bun av up` attempts a production dashboard build before starting.

Supported agent values are `claude`, `codex`, `antigravity`, `cursor`, `grok`, `kimi`, and `opencode`. Antigravity uses the `agy` executable. Install and authenticate the selected CLI. For a goal that does not need a tracker or dashboard, follow [chief orders](./chief-missions.md); explicit `--workspace` and `--verify` options can supply its configuration.

The setup wizard selects Linear or GitHub, the agent, workspace, tunnel, and completion checks. It writes project configuration to `valley.yaml` and user defaults/credentials to `~/.config/agent-valley/settings.yaml`. Project values override global values; existing unrelated global settings are preserved. The example YAML is a reference, not a ready-to-run configuration. OMA is optional in the target repository.

For a first run, use `agent.max_parallel: 1` and `delivery.mode: pr`. Authenticate the chosen CLI before starting Agent Valley. PR delivery requires authenticated `gh`; the target repository needs a usable remote. Increase concurrency after one small task passes verification and creates its PR.

## Completion checks

Code tasks require `verify.command` in `valley.yaml`. Use the target repository's deterministic test/typecheck commands, including dependency installation when a new worktree needs it. For example, for this repository:

```yaml
verify:
  command: bun install --frozen-lockfile && bun run typecheck && bun run test
  timeout_sec: 600
```

The check runs in the issue worktree before delivery. A failed check retries with its output attached; exhausted retries cancel the issue. A zero agent exit code alone does not mark a code task Done. If the work is a report, select analysis and an attempt-specific report path instead:

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
| GitHub | `/api/webhook/github` | Owner, repository, `github.token_env`, signing secret and state labels. Export the named token environment variable. Register an Issues webhook with JSON payloads; use `github.webhook_secret` from `valley.yaml`. |

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
| Agent never starts | Check operations-panel blockers/retry time, concurrency, budget limits, selected agent executable/authentication, and webhook delivery in the tracker. |
| Task retries after producing code | Read the verification/delivery error. Run the configured check in the retained worktree; check Git remote and `gh` authentication. |
| Process exits without a result | Run the agent interactively once to authenticate and confirm its installed version. Update incompatible CLIs. The task fails promptly instead of waiting for the full task timeout. |
| Dashboard says unavailable | Run `bun av doctor` and inspect `.av.log` or the foreground output for the initialization failure. Fix it and restart. A connected SSE socket does not imply a healthy scheduler. |
| Runtime restarted while an agent was alive | Recovery reserves that task until the old process exits, then retries retained work. Inspect a stuck process before terminating it. |
| Read-only user cannot control agents | Sign in separately for controls with the intervention token. Viewing status does not require that token. |

Run `bun run test`, `bun run typecheck`, `bun run lint`, and `./scripts/harness/validate.sh` for repository checks. `validate.sh` checks source safety, architecture and coverage; `av doctor` checks runtime configuration and prerequisites. Use `bun run test` for the Vitest suite; bare `bun test` selects Bun's different test runner.

## Optional instruction harness

`scripts/install.sh` copies agent instructions and documentation into another project. It does not install the CLI/dashboard. It is optional for running the farm. Review copied conventions for the target project, especially before accepting the optional repository-specific CI workflows.

```bash
cd your-existing-project
curl -fsSL https://raw.githubusercontent.com/first-fluke/agent-valley/main/scripts/install.sh | bash
# Without an interactive terminal:
# curl ... | bash -s -- --yes --no-workflows
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
`team.id` in `valley.yaml` or `~/.config/agent-valley/settings.yaml`.
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
