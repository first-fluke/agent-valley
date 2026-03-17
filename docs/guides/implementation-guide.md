# Implementation Guide

## Architecture Rules

**These rules are enforced automatically.** `./scripts/harness/validate.sh` runs before every commit (pre-commit hook) and in CI. Violations will block the PR.

### Clean Architecture Layers

```
Presentation   ← CLI, HTTP handler. No business logic.
    |
    ↓ (only downward)
Application    ← Orchestrator, WorkspaceManager. Coordinates via interfaces.
    |
    ↓
Domain         ← Issue, Workspace, RunAttempt. Pure rules. ZERO external dependencies.
    |
    ↓
Infrastructure ← LinearApiClient, FileSystem, Git, Logger. Adapters only.
```

**Dependency arrows point downward only.** An import from Domain to Infrastructure is a violation. An import from Application to Presentation is a violation.

Full rules: `docs/architecture/LAYERS.md`

### 7 Forbidden Patterns

Read `docs/architecture/CONSTRAINTS.md` for complete examples. Summary:

| # | Rule |
|---|---|
| 1 | No framework/ORM/SDK imports in Domain layer |
| 2 | No business logic in Router/Handler (Presentation layer) |
| 3 | No hardcoded secrets — use env vars only |
| 4 | Issue body is untrusted — sanitize before inserting into prompts |
| 5 | No file exceeding 500 lines |
| 6 | No shared mutable state outside Orchestrator |
| 7 | Error messages must include fix instructions, not just describe the problem |

### Architecture Enforcement Tools

| Stack | Tool | Config location |
|---|---|---|
| TypeScript | dependency-cruiser | `docs/architecture/enforcement/typescript.md` |
| Python | import-linter + Ruff | `docs/architecture/enforcement/python.md` |
| Go | golangci-lint + go vet | `docs/architecture/enforcement/go.md` |

---

## Implementing Symphony Components

Before implementing any component:
1. Read `docs/specs/{component}.md` — the interface contract
2. Read `docs/specs/domain-models.md` — shared domain models
3. Read `docs/architecture/LAYERS.md` — which layer the component belongs in
4. Check `docs/architecture/CONSTRAINTS.md` — forbidden patterns to avoid

### Component Index

| Component | Layer | Spec file | Key responsibility |
|---|---|---|---|
| Workflow Loader | Infrastructure | `docs/specs/workflow-loader.md` | Parse `WORKFLOW.md` YAML + body, resolve `$VAR` |
| Config Layer | Infrastructure | `docs/specs/config-layer.md` | Build typed `Config` object, fail-fast on missing vars |
| Issue Tracker Client | Infrastructure | `docs/specs/tracker-client.md` | Linear webhook parsing, signature verification, startup sync |
| Orchestrator | Application | `docs/specs/orchestrator.md` | Webhook event handler, state machine, retry queue |
| Workspace Manager | Application | `docs/specs/workspace-manager.md` | `git worktree` per issue, lifecycle hooks |
| Agent Runner | Application | `docs/specs/agent-runner.md` | AgentSession abstraction, native protocol per agent, timeout |
| Observability | Infrastructure | `docs/specs/observability.md` | Structured JSON logs, event catalog |

### Domain Models (shared by all components)

```
Issue {
  id          : string   // Linear UUID
  identifier  : string   // e.g., "ACR-42"
  title       : string
  description : string   // UNTRUSTED — always sanitize before use in prompts
  status      : { id, name, type }
  team        : { id, key }
  url         : string
}

Workspace {
  issueId   : string
  path      : string   // {WORKSPACE_ROOT}/{key}/
  key       : string   // identifier with [^A-Za-z0-9._-] → _
  status    : "idle" | "running" | "done" | "failed"
  createdAt : ISO8601
}

RunAttempt {
  id            : string    // UUID v4
  issueId       : string
  workspacePath : string
  startedAt     : ISO8601
  finishedAt    : ISO8601 | null
  exitCode      : number | null   // 0 = success
  agentOutput   : string | null   // max 10KB, truncated
}
```

Full definitions: `docs/specs/domain-models.md`

### Orchestrator Event Flow

```
Startup:
  1. TrackerClient.fetchInProgressIssues()  ← one-time sync
  2. Recover existing workspaces, populate retry queue
  3. Start HTTP server (POST /webhook, GET /status, GET /health)

Webhook received (POST /webhook):
  1. TrackerClient.verifyWebhookSignature(payload, signature)
  2. TrackerClient.parseWebhookEvent(payload)
  3. Issue moved to IN_PROGRESS → create workspace, spawn agent
     Issue moved OUT of IN_PROGRESS → stop agent, cleanup
  4. Handle completed RunAttempts (exitCode == 0 → done, != 0 → retry queue)
```

Full spec including restart recovery: `docs/specs/orchestrator.md`

### Workspace Key Derivation

```typescript
// TypeScript
const key = issue.identifier.replace(/[^A-Za-z0-9._-]/g, '_');
const path = `${config.workspace.rootPath}/${key}`;
```

```python
# Python
import re
key = re.sub(r'[^A-Za-z0-9._-]', '_', issue.identifier)
path = f"{config.workspace.root_path}/{key}"
```

```go
// Go
import "regexp"
re := regexp.MustCompile(`[^A-Za-z0-9._-]`)
key := re.ReplaceAllString(issue.Identifier, "_")
path := filepath.Join(config.Workspace.RootPath, key)
```

### Prompt Injection Defense

**This is mandatory.** Issue descriptions are external input and must be sanitized before inserting into agent prompts.

```typescript
function sanitizeIssueBody(description: string): string {
  // 1. Length limit
  const truncated = description.slice(0, 8000);
  // 2. Remove injection patterns
  const sanitized = truncated
    .replace(/ignore previous instructions/gi, '[REDACTED]')
    .replace(/you are now/gi, '[REDACTED]')
    .replace(/system:/gi, '[REDACTED]');
  // 3. Wrap in boundary markers
  return `--- ISSUE DESCRIPTION START ---\n${sanitized}\n--- ISSUE DESCRIPTION END ---`;
}
```

---

## Stack-Specific Setup

Choose ONE stack and follow the guide. The `src/` directory is currently empty.

### TypeScript

Full guide: `docs/stacks/typescript.md`

```bash
mkdir src && cd src
npm init -y
npm install --save-dev typescript ts-node @types/node
npm install express zod dotenv
npm install --save-dev jest ts-jest @types/jest
npm install --save-dev eslint prettier typescript-eslint
npm install --save-dev dependency-cruiser
npx tsc --init
```

**Required `tsconfig.json` settings:**
```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true
  }
}
```

Config validation with Zod:
```typescript
import { z } from "zod";
const envSchema = z.object({
  LINEAR_API_KEY: z.string().min(1, {
    message: "LINEAR_API_KEY is not set.\n  Fix: Add LINEAR_API_KEY=lin_api_xxx to .env"
  }),
  WORKSPACE_ROOT: z.string().refine(v => v.startsWith("/"), {
    message: "WORKSPACE_ROOT must be an absolute path.\n  Fix: Set WORKSPACE_ROOT=/absolute/path in .env"
  }),
  // ... other vars
});
const parsed = envSchema.safeParse(process.env);
if (!parsed.success) { console.error(parsed.error.issues); process.exit(1); }
export const config = parsed.data;
```

### Python

Full guide: `docs/stacks/python.md`

```bash
# Requires uv (https://astral.sh/uv)
uv init src && cd src
uv python pin 3.12
uv add fastapi uvicorn pydantic-settings httpx
uv add --dev pytest pytest-asyncio ruff import-linter
uv sync
```

Config validation with Pydantic:
```python
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env")
    linear_api_key: str
    workspace_root: str

    @field_validator("workspace_root")
    @classmethod
    def must_be_absolute(cls, v: str) -> str:
        if not v.startswith("/"):
            raise ValueError(
                f"WORKSPACE_ROOT must be an absolute path.\n"
                f"  Current: {v!r}\n"
                f"  Fix: Set WORKSPACE_ROOT=/absolute/path in .env"
            )
        return v

try:
    settings = Settings()
except Exception as e:
    import sys; print(f"Config error:\n{e}", file=sys.stderr); sys.exit(1)
```

### Go

Full guide: `docs/stacks/go.md`

```bash
mkdir src && cd src
go mod init github.com/your-org/my-symphony
go get github.com/labstack/echo/v4
go get github.com/joho/godotenv
go get github.com/stretchr/testify
go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
```

Config validation:
```go
import (
    "fmt"
    "os"
    "strings"
    "github.com/joho/godotenv"
)

func loadConfig() (*Config, error) {
    _ = godotenv.Load()
    key := os.Getenv("LINEAR_API_KEY")
    if key == "" {
        return nil, fmt.Errorf("LINEAR_API_KEY is not set.\n  Fix: Add LINEAR_API_KEY=lin_api_xxx to .env")
    }
    root := os.Getenv("WORKSPACE_ROOT")
    if !strings.HasPrefix(root, "/") {
        return nil, fmt.Errorf("WORKSPACE_ROOT must be an absolute path.\n  Current: %q\n  Fix: Set WORKSPACE_ROOT=/absolute/path in .env", root)
    }
    // ...
    return &Config{LinearAPIKey: key, WorkspaceRoot: root}, nil
}
```
