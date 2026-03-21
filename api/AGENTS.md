# AGENTS.md — Mapple API (FastAPI Backend)

## Architecture: Router → Service → Repository

```
Router (src/routes/)       — HTTP layer: parse request, validate input, return response envelope
   ↓
Service (src/services/)    — Business logic: orchestrate repositories, enforce rules
   ↓
Repository (src/repos/)    — Data access: SQLAlchemy queries, single-table focus
```

**Dependency direction:** Router → Service → Repository → Database. Never skip layers.

---

## Layer Rules

### Router (`src/routes/`)
- Parse path/query/body parameters via Pydantic models
- Call the corresponding service method
- Wrap results in the standard response envelope
- No direct database access. No business logic.
- Dependency injection via `Depends()` for services and auth

### Service (`src/services/`)
- Contains all business rules and validation
- Calls one or more repositories
- Raises `AppError` subclasses on domain errors
- Never imports `FastAPI`, `Request`, or `Response`

### Repository (`src/repos/`)
- One repository per database table/entity
- Accepts an `AsyncSession` via dependency injection
- Returns SQLAlchemy model instances or `None`
- No business logic — pure data access

---

## Response Envelope

### Success

```json
{
  "data": { ... },
  "meta": { "page": 1, "size": 20, "total": 100, "total_pages": 5 },
  "errors": null
}
```

### Error

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "User not found: 123",
    "details": null
  }
}
```

Use `src/lib/pagination.py` helpers (`PaginatedResponse`, `SuccessResponse`, `paginate`) for success responses.
Use `src/lib/exceptions.py` error classes (`AppError`, `NotFoundError`, `UnauthorizedError`, `ForbiddenError`) for errors.

---

## Adding a New Feature

1. **Model** — Define SQLAlchemy model in `src/models/`
2. **Repository** — Create repository in `src/repos/` with CRUD methods
3. **Service** — Create service in `src/services/` with business logic
4. **Router** — Create router in `src/routes/`, register in `src/main.py`
5. **Migration** — `cd api && uv run alembic revision --autogenerate -m "description"`

---

## Shared Utilities (`src/lib/`)

| Module | Purpose |
|---|---|
| `config.py` | `pydantic-settings` based config from env vars |
| `database.py` | Async SQLAlchemy engine, session factory, `Base` |
| `redis.py` | Async Redis client |
| `storage.py` | MinIO async client for object storage |
| `exceptions.py` | `AppError` hierarchy + FastAPI exception handlers |
| `pagination.py` | Response envelope models + `paginate()` helper |
| `auth.py` | JWT encode/decode + `get_current_user` dependency |

---

## Commands

```bash
# Install dependencies
cd api && uv sync

# Run development server
cd api && uv run uvicorn src.main:app --reload

# Run migrations
cd api && uv run alembic upgrade head

# Create migration
cd api && uv run alembic revision --autogenerate -m "description"

# Lint
cd api && uv run ruff check src/

# Type check
cd api && uv run mypy src/

# Run tests
cd api && uv run pytest
```

---

## Conventions

- All async. No sync database calls.
- Validate external input at the boundary (Router layer) only.
- Error messages must include the resource name and identifier.
- One file per router, service, and repository.
- Import from `src.lib` — never re-implement shared utilities.
