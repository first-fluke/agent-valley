#!/usr/bin/env bash
# scripts/dev.sh — One-command dev environment bootstrap
#
# Usage:
#   ./scripts/dev.sh
#
# What it does:
#   1. Checks required prerequisites (git, env vars)
#   2. Loads .env if it exists (warns if missing)
#   3. Validates WORKSPACE_ROOT is set and is an absolute path
#   4. Runs lint/test if src/ exists
#   5. Prints a clear status summary
#
# Idempotent: safe to run multiple times.
# References: AGENTS.md section 1 Build & Test

set -e
set -u

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
YLW='\033[0;33m'
GRN='\033[0;32m'
BLU='\033[0;34m'
RST='\033[0m'

# ── Helpers ───────────────────────────────────────────────────────────────────
info()  { printf "${BLU}[dev]${RST}  %s\n" "$*"; }
ok()    { printf "${GRN}[ok]${RST}   %s\n" "$*"; }
warn()  { printf "${YLW}[warn]${RST} %s\n" "$*" >&2; }
fail()  { printf "${RED}[fail]${RST} %s\n" "$*" >&2; }

# Print a section header
section() { printf "\n${BLU}── %s ──────────────────────────────────────────────${RST}\n" "$*"; }

# Accumulate summary lines
SUMMARY_OK=()
SUMMARY_WARN=()
SUMMARY_FAIL=()

add_ok()   { SUMMARY_OK+=("$*"); }
add_warn() { SUMMARY_WARN+=("$*"); }
add_fail() { SUMMARY_FAIL+=("$*"); }

# ── Script location ───────────────────────────────────────────────────────────
# Resolve repo root regardless of where the script is called from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ─────────────────────────────────────────────────────────────────────────────
section "Prerequisites"

# git
if ! command -v git >/dev/null 2>&1; then
  fail "git is not installed."
  fail "  → Install git: https://git-scm.com/downloads"
  exit 1
fi
ok "git $(git --version | awk '{print $3}')"

# ─────────────────────────────────────────────────────────────────────────────
section ".env"

ENV_FILE="${REPO_ROOT}/.env"
ENV_EXAMPLE="${REPO_ROOT}/.env.example"

if [ -f "${ENV_FILE}" ]; then
  # shellcheck source=/dev/null
  set -a
  # Load .env but ignore comments and blank lines
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|\#*) continue ;;
    esac
    export "${line?}"
  done < "${ENV_FILE}"
  set +a
  ok ".env loaded from ${ENV_FILE}"
  add_ok ".env loaded"
else
  warn ".env not found at ${ENV_FILE}"
  warn "  → Copy .env.example and fill in your values:"
  warn "      cp ${ENV_EXAMPLE} ${ENV_FILE}"
  warn "  → Required variables are listed in .env.example"
  add_warn ".env missing — copy from .env.example"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "Environment variables"

# Required variables (see AGENTS.md section 1 and .env.example)
REQUIRED_VARS=(
  LINEAR_API_KEY
  LINEAR_TEAM_ID
  LINEAR_TEAM_UUID
  LINEAR_WORKFLOW_STATE_IN_PROGRESS
  LINEAR_WORKFLOW_STATE_DONE
  LINEAR_WORKFLOW_STATE_CANCELLED
  WORKSPACE_ROOT
)

MISSING_VARS=()
for var in "${REQUIRED_VARS[@]}"; do
  value="${!var:-}"
  if [ -z "$value" ]; then
    MISSING_VARS+=("$var")
  fi
done

if [ "${#MISSING_VARS[@]}" -gt 0 ]; then
  fail "Missing required environment variables:"
  for var in "${MISSING_VARS[@]}"; do
    fail "  ${var}"
    fail "    → Add it to ${ENV_FILE}"
    fail "    → See ${ENV_EXAMPLE} for format"
  done
  add_fail "Missing env vars: ${MISSING_VARS[*]}"
  # Continue checks but will exit at the end
  ENV_VALID=false
else
  ok "All required environment variables are set"
  add_ok "All env vars present"
  ENV_VALID=true
fi

# ─────────────────────────────────────────────────────────────────────────────
section "WORKSPACE_ROOT"

WORKSPACE_ROOT="${WORKSPACE_ROOT:-}"

if [ -z "${WORKSPACE_ROOT}" ]; then
  fail "WORKSPACE_ROOT is not set."
  fail "  → Add it to ${ENV_FILE}"
  fail "  → It must be an absolute path, e.g.: WORKSPACE_ROOT=/home/you/workspaces"
  add_fail "WORKSPACE_ROOT not set"
  WORKSPACE_VALID=false
else
  # Must be absolute
  case "${WORKSPACE_ROOT}" in
    /*)
      ok "WORKSPACE_ROOT=${WORKSPACE_ROOT}"
      # Create if not exists (idempotent)
      mkdir -p "${WORKSPACE_ROOT}"
      ok "WORKSPACE_ROOT directory ready"
      add_ok "WORKSPACE_ROOT=${WORKSPACE_ROOT}"
      WORKSPACE_VALID=true
      ;;
    *)
      fail "WORKSPACE_ROOT must be an absolute path."
      fail "  → Current value: \"${WORKSPACE_ROOT}\""
      fail "  → Fix: Set WORKSPACE_ROOT=/absolute/path/to/workspaces in ${ENV_FILE}"
      add_fail "WORKSPACE_ROOT is relative (must be absolute)"
      WORKSPACE_VALID=false
      ;;
  esac
fi

# ─────────────────────────────────────────────────────────────────────────────
section "Harness validation"

VALIDATE_SCRIPT="${REPO_ROOT}/scripts/harness/validate.sh"
if [ -f "${VALIDATE_SCRIPT}" ]; then
  chmod +x "${VALIDATE_SCRIPT}"
  if "${VALIDATE_SCRIPT}"; then
    ok "Harness validation passed"
    add_ok "Harness validate passed"
  else
    fail "Harness validation failed — see output above"
    add_fail "Harness validate failed"
  fi
else
  warn "scripts/harness/validate.sh not found — skipping"
  add_warn "harness/validate.sh missing"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "Stack lint / test"

SRC_DIR="${REPO_ROOT}/src"
if [ ! -d "${SRC_DIR}" ]; then
  info "No src/ directory found — skipping lint/test."
  info "Add your stack source code to src/ to enable this step."
  add_warn "src/ not found — lint/test skipped"
else
  # TypeScript
  if [ -f "${REPO_ROOT}/package.json" ]; then
    info "Detected TypeScript/Node project"
    if command -v npm >/dev/null 2>&1; then
      info "Running: npm run lint"
      if npm --prefix "${REPO_ROOT}" run lint 2>/dev/null; then
        ok "ESLint passed"
        add_ok "ESLint passed"
      else
        add_fail "ESLint failed"
      fi
      info "Running: npm test"
      if npm --prefix "${REPO_ROOT}" test 2>/dev/null; then
        ok "npm test passed"
        add_ok "npm test passed"
      else
        add_fail "npm test failed"
      fi
    else
      warn "npm not found — install Node.js to run lint/test"
      add_warn "npm not installed"
    fi
  fi

  # Python
  if [ -f "${REPO_ROOT}/pyproject.toml" ] || [ -f "${REPO_ROOT}/setup.py" ]; then
    info "Detected Python project"
    if command -v ruff >/dev/null 2>&1; then
      info "Running: ruff check"
      if ruff check "${SRC_DIR}"; then
        ok "Ruff passed"
        add_ok "Ruff passed"
      else
        add_fail "Ruff failed"
      fi
    else
      warn "ruff not found — pip install ruff"
      add_warn "ruff not installed"
    fi
    if command -v pytest >/dev/null 2>&1; then
      info "Running: pytest"
      if pytest "${REPO_ROOT}" -q; then
        ok "pytest passed"
        add_ok "pytest passed"
      else
        add_fail "pytest failed"
      fi
    else
      warn "pytest not found — pip install pytest"
      add_warn "pytest not installed"
    fi
  fi

  # Go
  if [ -f "${REPO_ROOT}/go.mod" ]; then
    info "Detected Go project"
    if command -v golangci-lint >/dev/null 2>&1; then
      info "Running: golangci-lint"
      if golangci-lint run "${REPO_ROOT}/..."; then
        ok "golangci-lint passed"
        add_ok "golangci-lint passed"
      else
        add_fail "golangci-lint failed"
      fi
    else
      warn "golangci-lint not found — see docs/architecture/enforcement/go.md"
      add_warn "golangci-lint not installed"
    fi
    if command -v go >/dev/null 2>&1; then
      info "Running: go test ./..."
      if go test "${REPO_ROOT}/..."; then
        ok "go test passed"
        add_ok "go test passed"
      else
        add_fail "go test failed"
      fi
    fi
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
section "Summary"

if [ "${#SUMMARY_OK[@]}" -gt 0 ]; then
  for msg in "${SUMMARY_OK[@]}"; do
    ok "$msg"
  done
fi
if [ "${#SUMMARY_WARN[@]}" -gt 0 ]; then
  for msg in "${SUMMARY_WARN[@]}"; do
    warn "$msg"
  done
fi
if [ "${#SUMMARY_FAIL[@]}" -gt 0 ]; then
  for msg in "${SUMMARY_FAIL[@]}"; do
    fail "$msg"
  done
  printf "\n"
  fail "Dev environment setup incomplete. Fix the errors above and re-run:"
  fail "  ./scripts/dev.sh"
  exit 1
fi

printf "\n"
ok "Dev environment ready."
info "Start the orchestrator: codex serve"
