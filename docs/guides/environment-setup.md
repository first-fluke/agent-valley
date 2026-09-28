# Environment Setup

## Step 0: Install the Harness

**New project** (cloned this repo directly):

Everything is already in place. Just reset the git history and start your own:

```bash
rm -rf .git
git init
git add -A
git commit -m "chore: init from agent-valley"
```

No need to run `install.sh` — the full scaffold is already present.

**Existing project** (adding the harness to a project you already have):

```bash
cd your-existing-project
curl -fsSL https://raw.githubusercontent.com/first-fluke/agent-valley/main/scripts/install.sh | bash
```

The installer auto-detects existing project files (`package.json`, `pyproject.toml`, `go.mod`) and installs only the harness layer:

| Item | Action |
|---|---|
| `.agents/`, `.claude/`, `docs/` | Copied |
| `scripts/harness/gc.sh`, `validate.sh` | Copied |
| `WORKFLOW.md`, `.env.example` | Copied |
| `AGENTS.md` | Appended (Symphony section added) |
| `CLAUDE.md` | `@AGENTS.md` line injected if missing |
| `.gitignore` | Missing entries appended |
| `src/`, `scripts/dev.sh` | **Skipped** |
| `.github/` workflows | **Optional** — asked interactively |

The installer is idempotent — safe to run multiple times.

---

## Step 1: Copy and Fill `.env`

```bash
cp .env.example .env
```

Edit `.env` with real values:

```bash
# Linear issue tracker
LINEAR_API_KEY=lin_api_YOUR_KEY_HERE    # Linear Personal API Key
LINEAR_TEAM_ID=ACR                                          # Your team identifier
LINEAR_TEAM_UUID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx      # Team UUID
LINEAR_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxx                # Webhook signing secret
LINEAR_WORKFLOW_STATE_TODO=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
LINEAR_WORKFLOW_STATE_IN_PROGRESS=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
LINEAR_WORKFLOW_STATE_DONE=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
LINEAR_WORKFLOW_STATE_CANCELLED=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# Symphony orchestrator
WORKSPACE_ROOT=/absolute/path/to/workspaces    # MUST be an absolute path
LOG_LEVEL=info                                  # debug | info | warn | error
LOG_FORMAT=json                                 # json | text

# Agent selection
AGENT_TYPE=claude                                 # claude | gemini | codex
# CLAUDE_MODEL=sonnet                             # optional model override
# GEMINI_MODEL=gemini-2.0-flash
# CODEX_MODEL=gpt-5.3-codex

# Optional
# OTEL_ENDPOINT=http://localhost:4317
```

**Important:** `.env` is gitignored. Never commit it.

---

## Step 2: Find Linear UUIDs

```bash
# Team UUID
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query":"{ teams { nodes { id key name } } }"}' | jq .

# Workflow state UUIDs
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query":"{ workflowStates { nodes { id name type } } }"}' | jq .
```

Look for states with `type: "unstarted"` (Todo), `type: "started"` (In Progress), `type: "completed"` (Done), `type: "cancelled"` (Cancelled).

---

## Step 3: Set Up Linear Webhook

1. Go to Linear → Settings → API → Webhooks
2. Create a new webhook:
   - **URL:** `https://your-orchestrator-host:9741/webhook`
   - **Events:** Issue updates
3. Copy the **signing secret** → set as `LINEAR_WEBHOOK_SECRET` in `.env`

For local development, expose your local server via tunnel:
```bash
npx localtunnel --port 9741
# or
cloudflared tunnel --url http://localhost:9741
```

---

## Step 4: Validate Environment

```bash
./scripts/harness/validate.sh
```

This script:
- Checks all required environment variables are set
- Validates `WORKSPACE_ROOT` is an absolute path
- Scans for hardcoded secrets and architecture violations
- Confirms harness scripts are executable

For new projects, you can also run the full bootstrap (lint + tests):
```bash
./scripts/dev.sh
```

**If validation fails:** Each error includes the exact fix instruction. For example:
```
FAIL: WORKSPACE_ROOT is not set.
  → Add WORKSPACE_ROOT=/absolute/path to .env
  → Copy from .env.example if unsure
```

---

## Step 5: Dashboard and webhook access

`av up`, `av dev`, and the dashboard's direct `dev`/`start` scripts bind
the dashboard to `127.0.0.1` by default. The tunnel points to a separate
loopback listener (port `SERVER_PORT + 1`) that forwards only POST
`/api/webhook` and POST `/api/webhook/github`. Control routes and the UI
are unavailable through that tunnel.

If you only open the dashboard at `http://localhost:PORT`, you need nothing —
it works out of the box. Remote access requires one of:

| Env var | Effect |
|---|---|
| `SYMPHONY_DASHBOARD_TOKEN=<token>` | Browser sign-in for `/api/status` and `/api/events`; CLI status/top send this token as Bearer when present in their environment. |
| `SYMPHONY_ALLOW_REMOTE_STATUS=1` | Requires `SYMPHONY_DASHBOARD_TOKEN` even for local requests; without it, every request is rejected. |
| `SYMPHONY_INTERVENTION_TOKEN=<token>` | Browser sign-in for intervention. Use a separate token from the status token. |
| `SYMPHONY_DASHBOARD_HOST=<host>` | CLI-managed dashboard bind address. Non-loopback values require both dashboard and intervention tokens. |
| `SYMPHONY_WEBHOOK_PORT=<port>` | Override the webhook-only listener port; default is `SERVER_PORT + 1`. Point any named tunnel at this port. |

`/api/intervention` (pause/resume/append_prompt/abort a live agent run) is
gated by `SYMPHONY_INTERVENTION_TOKEN` and
`SYMPHONY_ALLOW_REMOTE_INTERVENTION=1`. The browser signs in with configured
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
