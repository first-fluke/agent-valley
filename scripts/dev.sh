#!/usr/bin/env bash
# scripts/dev.sh — One-command dev environment bootstrap
#
# Usage:
#   ./scripts/dev.sh
#
# What it does:
#   1. Checks required prerequisites (git)
#   2. Validates av.yaml exists in project root
#   3. Validates ~/.config/agent-valley/settings.yaml exists (warns if missing)
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
section "Configuration"

PROJECT_FILE="${REPO_ROOT}/av.yaml"
GLOBAL_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/agent-valley"
GLOBAL_FILE="${GLOBAL_DIR}/settings.yaml"

if [ -f "${PROJECT_FILE}" ]; then
  ok "Project config found at ${PROJECT_FILE}"
  add_ok "Project config found"
else
  fail "av.yaml not found at ${PROJECT_FILE}"
  fail "  → Run 'av setup' to create av.yaml"
  add_fail "av.yaml missing — run av setup"
fi

if [ -f "${GLOBAL_FILE}" ]; then
  ok "Global config found at ${GLOBAL_FILE}"
  add_ok "Global settings.yaml found"
else
  warn "Global config not found at ${GLOBAL_FILE}"
  warn "  → Run 'av setup' to create global settings"
  warn "  → av.yaml can include all required fields if preferred"
  add_warn "Global settings.yaml missing"
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

# Detect source directories: monorepo (packages/*/src, apps/*/src) or flat (src/)
HAS_SRC=false
if [ -d "${REPO_ROOT}/src" ] || [ -d "${REPO_ROOT}/packages" ] || [ -d "${REPO_ROOT}/apps" ]; then
  HAS_SRC=true
fi

if [ "${HAS_SRC}" = "false" ]; then
  info "No source directory found — skipping lint/test."
  info "Expected: src/, packages/*, or apps/*"
  add_warn "No source directory — lint/test skipped"
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
      if ruff check "${REPO_ROOT}"; then
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
info "Start the orchestrator: av up"
