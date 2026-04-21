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

## Step 5: Dashboard Status Endpoints (Optional)

`/api/status` and `/api/events` expose orchestrator runtime state (active
workspaces, issue identifiers, retry queue). `bun av dev` tunnels the dashboard
through ngrok for Linear webhook delivery, so by default these endpoints are
**blocked for any request whose `Host` header is not `localhost`**.

If you only open the dashboard at `http://localhost:PORT`, you need nothing —
it works out of the box. Remote access requires one of:

| Env var | Effect |
|---|---|
| `SYMPHONY_DASHBOARD_TOKEN=<token>` | Remote requests must include `Authorization: Bearer <token>` |
| `SYMPHONY_ALLOW_REMOTE_STATUS=1` | Disables the host gate entirely (not recommended for ngrok) |

`/api/webhook` is always public — it verifies Linear's HMAC signature
independently, so the host gate does not apply.
