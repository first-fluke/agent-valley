# Go Getting Started Guide

> Reference this file when starting a Symphony implementation with the Go stack.
> For layer principles see `docs/architecture/LAYERS.md`, for forbidden patterns see `docs/architecture/CONSTRAINTS.md`.

---

## Recommended Stack

| Role                     | Choice         |
| ------------------------ | -------------- |
| Language                 | Go 1.22+       |
| HTTP Server              | Echo v4        |
| SQL Queries              | sqlx           |
| DB Migrations            | golang-migrate |
| Testing                  | testify        |
| Environment Variables    | godotenv       |
| Architecture/Code Linter | golangci-lint  |

---

## Project Initialization

```bash
# 1. Create project directory
mkdir my-symphony && cd my-symphony

# 2. Initialize Go module
go mod init github.com/your-org/my-symphony

# 3. Add core dependencies
go get github.com/labstack/echo/v4
go get github.com/jmoiron/sqlx
go get github.com/golang-migrate/migrate/v4
go get github.com/joho/godotenv

# 4. Test dependencies
go get github.com/stretchr/testify

# 5. Install golangci-lint
brew install golangci-lint
# or
curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh \
  | sh -s -- -b $(go env GOPATH)/bin v1.57.2
```

---

## Directory Structure

Reflects the layers defined in `docs/architecture/LAYERS.md` alongside Go's standard layout.

```
my-symphony/
├── cmd/
│   └── server/
│       └── main.go           ← Entry point: DI assembly + server start
├── internal/
│   ├── domain/
│   │   ├── issue.go          ← Issue domain model (pure struct)
│   │   ├── workspace.go      ← Workspace domain model
│   │   ├── run_attempt.go    ← RunAttempt domain model
│   │   └── ports/
│   │       ├── issue_tracker.go  ← Interface definition (implemented by Infrastructure)
│   │       └── workspace.go
│   ├── application/
│   │   ├── orchestrator/
│   │   │   ├── webhook_handler.go
│   │   │   ├── state_machine.go
│   │   │   ├── retry_queue.go
│   │   │   └── orchestrator.go
│   │   └── workspace_manager.go
│   ├── infrastructure/
│   │   ├── linear/
│   │   │   └── client.go     ← IssueTracker interface implementation
│   │   ├── filesystem/
│   │   │   └── workspace.go
│   │   ├── git/
│   │   │   └── git.go
│   │   └── logger/
│   │       └── logger.go
│   └── presentation/
│       ├── handler/
│       │   └── issue.go
│       └── router.go
├── .golangci.yml
├── Makefile
├── go.mod
└── go.sum
```

Using `internal/` lets the Go compiler block imports from external packages, which helps enforce layer boundaries.

---

## Environment Variable Loading — godotenv

```go
// cmd/server/main.go
package main

import (
    "fmt"
    "log"
    "os"

    "github.com/joho/godotenv"
)

type Config struct {
    LinearAPIKey                    string
    LinearTeamID                    string
    LinearWorkflowStateInProgress   string
    LinearWorkflowStateDone         string
    LinearWorkflowStateCancelled    string
    WorkspaceRoot                   string
    LogLevel                        string
}

func loadConfig() (*Config, error) {
    // Load .env file (works with env vars even if file doesn't exist)
    _ = godotenv.Load()

    required := []struct {
        key  string
        hint string
    }{
        {"LINEAR_API_KEY", "Add it to .env. Format: LINEAR_API_KEY=lin_api_xxxxxxxx"},
        {"LINEAR_TEAM_ID", "Find it in Linear: Settings → Members → Team"},
        {"LINEAR_WORKFLOW_STATE_IN_PROGRESS", "Find it in Linear: Settings → Workflow"},
        {"LINEAR_WORKFLOW_STATE_DONE", "Find it in Linear: Settings → Workflow"},
        {"LINEAR_WORKFLOW_STATE_CANCELLED", "Find it in Linear: Settings → Workflow"},
        {"WORKSPACE_ROOT", "Must be an absolute path. Example: WORKSPACE_ROOT=/home/user/workspaces"},
    }

    var missing []string
    for _, r := range required {
        if os.Getenv(r.key) == "" {
            missing = append(missing, fmt.Sprintf("  %s: %s", r.key, r.hint))
        }
    }

    if len(missing) > 0 {
        return nil, fmt.Errorf(
            "configuration error — missing environment variables:\n%s\n\n"+
                "Copy .env.example to .env and fill in the values.",
            joinLines(missing),
        )
    }

    workspaceRoot := os.Getenv("WORKSPACE_ROOT")
    if !isAbsolutePath(workspaceRoot) {
        return nil, fmt.Errorf(
            "WORKSPACE_ROOT must be an absolute path.\n"+
                "  Current value: %q\n"+
                "  Fix: Set WORKSPACE_ROOT=/absolute/path in .env",
            workspaceRoot,
        )
    }

    return &Config{
        LinearAPIKey:                  os.Getenv("LINEAR_API_KEY"),
        LinearTeamID:                  os.Getenv("LINEAR_TEAM_ID"),
        LinearWorkflowStateInProgress: os.Getenv("LINEAR_WORKFLOW_STATE_IN_PROGRESS"),
        LinearWorkflowStateDone:       os.Getenv("LINEAR_WORKFLOW_STATE_DONE"),
        LinearWorkflowStateCancelled:  os.Getenv("LINEAR_WORKFLOW_STATE_CANCELLED"),
        WorkspaceRoot:                 workspaceRoot,
        LogLevel:                      getEnvOrDefault("LOG_LEVEL", "info"),
    }, nil
}

func getEnvOrDefault(key, defaultVal string) string {
    if v := os.Getenv(key); v != "" {
        return v
    }
    return defaultVal
}

func isAbsolutePath(p string) bool {
    return len(p) > 0 && p[0] == '/'
}

func joinLines(lines []string) string {
    result := ""
    for _, l := range lines {
        result += l + "\n"
    }
    return result
}

func main() {
    cfg, err := loadConfig()
    if err != nil {
        log.Fatalf("Startup failed:\n%v", err)
    }
    _ = cfg
    // ... start server
}
```

---

## Linter Execution

```bash
# Standard static analysis
go vet ./...

# Integrated linter
golangci-lint run ./...

# Unreachable code detection
deadcode -test ./...
```

---

## Makefile

```makefile
.PHONY: build run test vet lint deadcode validate

build:
	go build -o bin/server ./cmd/server

run:
	go run ./cmd/server

test:
	go test -race ./...

vet:
	go vet ./...

lint:
	golangci-lint run ./...

deadcode:
	deadcode -test ./...

validate: vet lint
	@echo "Architecture check passed."
```

Run `make validate` locally; in CI, `scripts/harness/validate.sh` calls `make validate`.

---

## Architecture Linter Integration

Refer to `docs/architecture/enforcement/go.md` to configure `.golangci.yml`.
