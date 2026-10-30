# LAYERS.md — Dependency Direction Rules

> Language-agnostic. These rules apply identically regardless of stack.

---

## Layer Structure

```
Presentation
    ↓
Application
    ↓
Domain
    ↓
Infrastructure
```

Dependencies are only allowed in the top-down direction. Reverse direction is forbidden.

---

## Role of Each Layer

| Layer              | Role                                                                        | Symphony context examples                   |
| ------------------ | --------------------------------------------------------------------------- | ------------------------------------------- |
| **Presentation**   | Receives external requests and formats responses. No business logic.        | Router, Handler, CLI entry point            |
| **Application**    | Orchestrates use cases. Composes domain objects to complete workflows.      | Orchestrator, WorkspaceManager              |
| **Domain**         | Core business rules and models. No framework dependencies.                  | Issue, Workspace, RunAttempt                |
| **Infrastructure** | External system integration. Concrete implementations of domain interfaces. | Linear API Client, File System, Git, Logger |

---

## Dependency Direction Rules

**Allowed:**

- Presentation → Application
- Application → Domain
- Application → Infrastructure (through interfaces)
- Infrastructure → Domain (interface implementation)

**Forbidden:**

- Domain → Application
- Domain → Infrastructure
- Domain → Presentation
- Application → Presentation
- Infrastructure → Application (when it contains business logic)

---

## Symphony Context Application

### Presentation Layer

- `Router` / `Handler` — Receives HTTP requests, serializes responses
- `CLI` — Command-line entry point, flag parsing

Rule: Does not make business decisions. Passes input to the Application layer and formats results.

### Application Layer

- `Orchestrator` — Webhook event handler, state machine, retry queue. Sole authority over in-memory state.
- `WorkspaceManager` — Per-issue isolated directory + git worktree lifecycle management.

Rule: Composes domain models to complete workflows. Accesses external systems through interfaces.

### Domain Layer

- `Issue` — Linear issue identifier, status, body
- `Workspace` — Per-issue isolated workspace (path, status)
- `RunAttempt` — Agent execution attempt (start time, end time, result)

Rule: No external dependencies such as frameworks, ORMs, or HTTP clients. Only pure data structures and business rules.

### Infrastructure Layer

- `LinearApiClient` — Linear GraphQL adapter
- `FileSystem` — Directory creation, file read/write
- `Git` — git worktree command execution
- `Logger` — Structured JSON log output

Rule: Implements domain interfaces. Does not make business decisions.

---

## Violation Examples (Patterns agents must avoid)

### Violation 1 — Importing external SDK in Domain layer

```typescript
// Forbidden: importing Linear SDK directly in Domain model
import { LinearClient } from "@linear/sdk"; // ← violation

export class Issue {
  async updateStatus(client: LinearClient) { ... }
}
```

Correct approach: Domain defines interfaces only. LinearClient is implemented in the Infrastructure layer.

### Violation 2 — Business logic decisions in Infrastructure layer

```typescript
// Forbidden: retry count policy decided directly in repository implementation
export class LinearApiClient {
  async fetchIssue(id: string) {
    if (this.retryCount > 3) {
      return this.cancelWorkspace() // ← business decision: violation
    }
  }
}
```

Correct approach: Retry policy is decided in the Application layer (Orchestrator). Infrastructure only propagates call failures as exceptions.

---

## Enforcement Tools

For stack-specific dependency direction automated checks, see `docs/architecture/enforcement/`.
