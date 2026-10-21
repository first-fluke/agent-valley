# Config Layer Split: Global + Project YAML

## Status: Approved

## Problem

All configuration lives in a single `.env` file per project. User credentials (`LINEAR_API_KEY`) are copied across projects. `ROUTING_RULES` and `SCORE_ROUTING` are JSON strings crammed into env vars. `WORKFLOW.md` duplicates config via `$VAR` references. This prevents agent-valley from working as a standalone CLI tool.

## Decision

Split configuration into two YAML files with merge semantics:

### 1. Global — `~/.config/agent-valley/settings.yaml`

User-scoped credentials and defaults. Written once via `av setup`, used across all projects.

```yaml
linear:
  api_key: lin_api_xxx

agent:
  type: claude
  timeout: 3600
  max_retries: 3
  retry_delay: 60

logging:
  level: info
  format: json

server:
  port: 9741

team:
  supabase_url: https://xxx.supabase.co
  supabase_anon_key: eyJxxx
  id: team-1
  display_name: gracefullight
```

### 2. Project — `<target-project>/valley.yaml`

Project-specific settings + agent prompt template. Created via `av setup` in target project.

```yaml
linear:
  team_id: FIR
  team_uuid: uuid-xxx
  webhook_secret: whsec_xxx
  workflow_states:
    todo: state-uuid
    in_progress: state-uuid
    done: state-uuid
    cancelled: state-uuid

workspace:
  root: /Users/gracefullight/workspace/mapple

agent:
  type: claude  # override global default

delivery:
  mode: merge

prompt: |
  You are working on {{issue.identifier}}: {{issue.title}}.

  ## Description
  {{issue.description}}

  ## Workspace
  Path: {{workspace_path}}

  ## Instructions
  1. Read AGENTS.md first
  2. Implement the requested changes
  3. Run tests before finishing

routing:
  rules:
    - label: "scope:agent-valley"
      workspace_root: /Users/gracefullight/workspace/composer
      agent_type: codex
      delivery_mode: pr

scoring:
  model: haiku
  routes:
    easy:
      agent_type: claude
      delivery_mode: merge
    hard:
      agent_type: claude
      delivery_mode: pr
```

### Merge Priority

`valley.yaml` > `settings.yaml` > hardcoded defaults

### What Gets Removed

- `.env` / `.env.example` — replaced by the two YAML files
- `WORKFLOW.md` — prompt template moves into `valley.yaml` `prompt` field
- `$VAR` resolution in workflow loader — no longer needed, config comes from YAML merge
- `@t3-oss/env-nextjs` in dashboard — replaced by unified YAML config loader

### Key Changes by Component

| Component | Change |
|---|---|
| `packages/core/src/config/env.ts` | Replace env-based `loadConfig()` with YAML loader + merger |
| `packages/core/src/config/workflow-loader.ts` | Simplify to read `prompt` field from `valley.yaml` only |
| `apps/cli/src/setup.ts` | Write to `~/.config/agent-valley/settings.yaml` + `valley.yaml` |
| `apps/dashboard/src/lib/env.ts` | Replace `@t3-oss/env-nextjs` with shared YAML config loader |
| `apps/dashboard/src/lib/bootstrap.ts` | Use new config loader |
| `scripts/dev.sh` | Validate `settings.yaml` + `valley.yaml` instead of `.env` |
| `scripts/install.sh` | Generate `valley.yaml` template instead of copying `.env.example` |

### New CLI Flow

```
# First time (any machine)
av setup          # Interactive wizard → writes ~/.config/agent-valley/settings.yaml

# Per project
cd ~/workspace/my-project
av setup          # Detects global config exists → writes valley.yaml only

# Run
av up             # Reads settings.yaml + valley.yaml → starts orchestrator
```

### Zod Schema

Config validation stays Zod-based. Schema validates the merged YAML object (same shape as current `Config` type, minus env var naming).

### YAML Parser

Use `yaml` npm package (already common in Bun/Node ecosystem). Single `loadConfig()` function:
1. Read `~/.config/agent-valley/settings.yaml` (global)
2. Read `valley.yaml` from project root (local)
3. Deep merge (local wins)
4. Validate merged object with Zod
5. Return typed `Config`
