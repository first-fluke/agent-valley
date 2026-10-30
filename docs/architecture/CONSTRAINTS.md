# CONSTRAINTS.md — Forbidden Patterns

> Agents repeat and amplify bad patterns. The rules below are enforced mechanically.
> Stack-specific automation tools: see `docs/architecture/enforcement/`.

---

## Forbidden Patterns

### 1. No Framework Dependencies in Domain Layer

**Rule:** Domain layer files must not import frameworks, ORMs, HTTP clients, or external SDKs.

**Violation example:**
```python
# domain/issue.py
from sqlalchemy import Column, String  # Forbidden: ORM penetrating Domain
from linear_sdk import LinearClient    # Forbidden: external SDK penetrating Domain
```

**Correct approach:**
```python
# domain/issue.py
from dataclasses import dataclass

@dataclass
class Issue:
    id: str
    identifier: str
    title: str
    description: str
    status: str
```

---

### 2. No Business Logic in Router/Handler

**Rule:** The Presentation layer (Router, Handler, CLI) is responsible only for input parsing and response formatting. It must not make business decisions via conditional branching.

**Violation example:**
```typescript
// presentation/issueRouter.ts
router.post("/issues/:id/run", async (req, res) => {
  const issue = await linearClient.getIssue(req.params.id)
  if (issue.retryCount > 3) {
    // Forbidden: business decision
    await workspace.cancel(issue.id) // Forbidden: domain operation
  }
  res.json({ status: "ok" })
})
```

**Correct approach:**
```typescript
// presentation/issueRouter.ts
router.post("/issues/:id/run", async (req, res) => {
  const result = await orchestrator.handleIssue(req.params.id) // Delegate to Application
  res.json(result)
})
```

---

### 3. No Hardcoded Secrets

**Rule:** Do not write API keys, passwords, tokens, URLs, or IDs directly in code. Write them only in `.env`, and ensure `.env` is listed in `.gitignore`.

**Violation example:**
```go
// Forbidden
client := linear.NewClient("lin_api_abc123xyz")
teamID := "ACR"
```

**Correct approach:**
```go
apiKey := os.Getenv("LINEAR_API_KEY")
if apiKey == "" {
    log.Fatal("LINEAR_API_KEY is not set. Add it to .env (see .env.example)")
}
client := linear.NewClient(apiKey)
```

---

### 4. No Treating Issue Body as Trusted Input

**Rule:** Linear issue body is external input. It must be validated and sanitized at the boundary before inserting into prompts. Only `WORKFLOW.md` is trusted.

**Violation example:**
```typescript
// Forbidden: inserting issue body directly into prompt without validation
const prompt = `${workflowTemplate}\n\n${issue.description}`
await agentRunner.run(prompt)
```

**Correct approach:**
```typescript
// Validate at Presentation layer boundary, then pass to Application
const sanitizedDescription = sanitizeIssueBody(issue.description) // Length limit, injection pattern removal
await orchestrator.runIssue({ ...issue, description: sanitizedDescription })
```

---

### 5. No Single File Exceeding 500 Lines

**Rule:** If a single file exceeds 500 lines, responsibility is overly concentrated. Split by layer or concern.

**Violation example:**
```
orchestrator.ts  1,200 lines  // Forbidden: event handling, retry, state management, workspace management mixed together
```

**Correct approach:**
```
orchestrator/
├── webhookHandler.ts ← Webhook event handling
├── stateMachine.ts   ← State transition rules
├── retryQueue.ts     ← Retry queue
└── index.ts          ← Composition and external interface
```

---

### 6. No Shared Mutable State (Outside Orchestrator)

**Rule:** Do not use global variables or module-level mutable state outside the Orchestrator. The Orchestrator is the single authority owning in-memory state.

**Violation example:**
```python
# Forbidden: module-level global state
_active_workspaces: dict[str, Workspace] = {}  # Can be modified from anywhere

def get_workspace(issue_id: str) -> Workspace:
    return _active_workspaces[issue_id]
```

**Correct approach:**
```python
class Orchestrator:
    def __init__(self):
        self._state: OrchestratorRuntimeState = OrchestratorRuntimeState()

    def get_workspace(self, issue_id: str) -> Workspace:
        return self._state.active_workspaces[issue_id]
```

---

### 7. No Plain Warnings Without Remediation Instructions

**Rule:** Error messages must enable agents to self-correct by reading the message alone. Warnings that only describe symptoms are useless to agents.

**Violation example:**
```
Error: Missing environment variable
Error: Invalid configuration
Warning: Connection failed
```

**Correct approach:**
```
Error: LINEAR_API_KEY is not set.
  → Add it to .env file (copy from .env.example)
  → Location: /Users/you/project/.env
  → Format: LINEAR_API_KEY=lin_api_xxxxxxxx

Error: WORKSPACE_ROOT must be an absolute path.
  → Current value: "relative/path"
  → Fix: Set WORKSPACE_ROOT=/absolute/path/to/workspaces in .env
```

---

## Enforcement Automation

| Stack      | Tool                                                             | Configuration docs                            |
| ---------- | ---------------------------------------------------------------- | --------------------------------------------- |
| TypeScript | `scripts/check-import-rules.mjs` (dependency-cruiser equivalent) | `docs/architecture/enforcement/typescript.md` |
| Python     | import-linter + Ruff                                             | `docs/architecture/enforcement/python.md`     |
| Go         | golangci-lint + go vet                                           | `docs/architecture/enforcement/go.md`         |

CI runs these tools automatically (see `.github/workflows/ci.yml`); the
TypeScript import gate runs as `bun run check:imports`.
