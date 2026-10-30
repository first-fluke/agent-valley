# Python Getting Started Guide

> Reference this file when starting a Symphony implementation with the Python stack.
> For layer principles see `docs/architecture/LAYERS.md`, for forbidden patterns see `docs/architecture/CONSTRAINTS.md`.

---

## Recommended Stack

| Role                | Choice                  |
| ------------------- | ----------------------- |
| Language            | Python 3.12+            |
| HTTP Server         | FastAPI                 |
| ORM                 | SQLAlchemy 2.0          |
| Schema Validation   | Pydantic v2             |
| Migrations          | Alembic                 |
| Testing             | pytest + pytest-asyncio |
| Package Manager     | uv                      |
| Architecture Linter | import-linter           |
| Code Linter         | Ruff                    |

---

## Project Initialization — uv-based

```bash
# 1. Install uv (if not already installed)
curl -LsSf https://astral.sh/uv/install.sh | sh

# 2. Create project
uv init my-symphony && cd my-symphony

# 3. Pin Python version
uv python pin 3.12

# 4. Add core dependencies
uv add fastapi uvicorn sqlalchemy alembic pydantic-settings

# 5. Add dev dependencies
uv add --dev pytest pytest-asyncio httpx ruff import-linter

# 6. Activate virtual environment
source .venv/bin/activate
```

---

## Directory Structure

Directly reflects the layers defined in `docs/architecture/LAYERS.md`.

```
src/
├── domain/
│   ├── __init__.py
│   ├── issue.py              ← Issue domain model (pure dataclass)
│   ├── workspace.py          ← Workspace domain model
│   ├── run_attempt.py        ← RunAttempt domain model
│   └── ports/
│       ├── __init__.py
│       ├── issue_tracker_port.py  ← ABC interface (implemented by Infrastructure)
│       └── workspace_port.py
├── application/
│   ├── __init__.py
│   ├── orchestrator/
│   │   ├── __init__.py
│   │   ├── webhook_handler.py
│   │   ├── state_machine.py
│   │   └── retry_queue.py
│   └── workspace_manager.py
├── infrastructure/
│   ├── __init__.py
│   ├── linear_api_client.py  ← issue_tracker_port implementation
│   ├── file_system.py
│   ├── git.py
│   └── logger.py
├── presentation/
│   ├── __init__.py
│   ├── router.py
│   └── cli.py
└── main.py                   ← Entry point: DI assembly + server start
tests/
├── domain/
├── application/
└── infrastructure/
```

---

## pyproject.toml Key Settings

```toml
[project]
name = "my-symphony"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.111.0",
    "uvicorn[standard]>=0.29.0",
    "sqlalchemy>=2.0.0",
    "alembic>=1.13.0",
    "pydantic-settings>=2.0.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0.0",
    "pytest-asyncio>=0.23.0",
    "httpx>=0.27.0",
    "ruff>=0.4.0",
    "import-linter>=2.1.0",
]

[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B", "SIM"]
ignore = ["E501"]

[tool.ruff.lint.isort]
known-first-party = ["src"]
force-sort-within-sections = true

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]

[tool.importlinter]
root_package = src
```

---

## Environment Variable Loading — Pydantic Settings

```python
# src/infrastructure/config.py
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
    )

    linear_api_key: str
    linear_team_id: str
    linear_workflow_state_in_progress: str
    linear_workflow_state_done: str
    linear_workflow_state_cancelled: str
    workspace_root: str
    log_level: str = "info"

    @field_validator("workspace_root")
    @classmethod
    def must_be_absolute(cls, v: str) -> str:
        if not v.startswith("/"):
            raise ValueError(
                f"WORKSPACE_ROOT must be an absolute path.\n"
                f"  Current value: {v!r}\n"
                f"  Fix: Set WORKSPACE_ROOT=/absolute/path in .env"
            )
        return v

    @field_validator("log_level")
    @classmethod
    def must_be_valid_level(cls, v: str) -> str:
        allowed = {"debug", "info", "warn", "error"}
        if v not in allowed:
            raise ValueError(
                f"LOG_LEVEL must be one of {allowed}.\n"
                f"  Current value: {v!r}"
            )
        return v


# Instantiated once at startup. Terminates immediately on failure.
try:
    settings = Settings()
except Exception as e:
    import sys
    print(f"Configuration error:\n{e}", file=sys.stderr)
    sys.exit(1)
```

---

## Linter Execution

```bash
# Code style + import ordering
ruff check src/
ruff format --check src/

# Layer dependency check
lint-imports

# Tests
pytest
```

### Makefile Integration

```makefile
.PHONY: lint test validate

lint:
	ruff check src/
	ruff format --check src/
	lint-imports

test:
	pytest

validate: lint test
	@echo "All checks passed."
```

---

## Architecture Linter Integration

Refer to `docs/architecture/enforcement/python.md` to configure `.importlinter`.
