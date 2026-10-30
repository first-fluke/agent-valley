# Go Architecture Enforcement — go vet + golangci-lint

> Automatically checks layer dependency direction rules (`docs/architecture/LAYERS.md`) in CI and local development environments.

---

## Tools

| Tool            | Role                                                                      |
| --------------- | ------------------------------------------------------------------------- |
| `go vet`        | Standard static analysis. Catches bug patterns the compiler misses.       |
| `golangci-lint` | Unified linter for layer import restrictions, complexity, and code style. |
| `deadcode`      | Detects unreachable code.                                                 |

---

## Package Structure Rules

Go's package structure clearly reflects the layers.

```
src/
├── domain/          <- Domain layer: pure Go structs + interfaces. No external dependencies.
├── application/     <- Application layer: use case orchestration.
├── infrastructure/  <- Infrastructure layer: external system implementations.
└── presentation/    <- Presentation layer: HTTP handlers, CLI.
```

When combined with the standard Go layout:

```
cmd/
└── server/
    └── main.go
internal/
├── domain/
├── application/
├── infrastructure/
└── presentation/
```

Using `internal/` leverages the Go compiler's built-in feature that blocks imports from outside the package.

---

## golangci-lint Configuration

Create `.golangci.yml` in the project root.

```yaml
linters:
  enable:
    - govet
    - errcheck
    - staticcheck
    - revive
    - gocritic
    - depguard
    - cyclop

linters-settings:
  depguard:
    rules:
      domain-no-infrastructure:
        list-mode: lax
        files:
          - "**/domain/**/*.go"
        deny:
          - pkg: "*/infrastructure"
            desc: >
              Domain layer must not import from Infrastructure.
              See LAYERS.md.
              Fix: Define interfaces in domain/ and implement them in infrastructure/.
          - pkg: "*/application"
            desc: >
              Domain layer must not import from Application.
              See LAYERS.md.
          - pkg: "*/presentation"
            desc: >
              Domain layer must not import from Presentation.
              See LAYERS.md.
      infrastructure-no-application:
        list-mode: lax
        files:
          - "**/infrastructure/**/*.go"
        deny:
          - pkg: "*/application"
            desc: >
              Infrastructure layer must not import from Application.
              See LAYERS.md.
          - pkg: "*/presentation"
            desc: >
              Infrastructure layer must not import from Presentation.
              See LAYERS.md.

  cyclop:
    max-complexity: 10

  revive:
    rules:
      - name: exported
      - name: error-return
      - name: error-strings

issues:
  max-same-issues: 0
  exclude-use-default: false
```

---

## deadcode Installation and Usage

```bash
go install golang.org/x/tools/cmd/deadcode@latest
deadcode -test ./...
```

Reports unreachable functions and methods. Useful for finding unused interface methods after layer separation.

---

## Makefile Target

Add to the `Makefile` in the project root.

```makefile
.PHONY: lint vet deadcode validate

vet:
	go vet ./...

lint:
	golangci-lint run ./...

deadcode:
	deadcode -test ./...

validate: vet lint
	@echo "Architecture check passed."
```

Local execution:

```bash
make validate
```

Add to `scripts/harness/validate.sh` for CI:

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "==> Checking architecture layer constraints (Go)..."
make validate

echo "==> Architecture check passed."
```

---

## golangci-lint Installation

```bash
# macOS
brew install golangci-lint

# or using the official install script
curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh \
  | sh -s -- -b $(go env GOPATH)/bin v1.57.2
```

Verify the version with `golangci-lint --version`. CI and local environments must use the same version.
