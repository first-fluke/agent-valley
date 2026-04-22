#!/usr/bin/env bash
# scripts/harness/validate.sh — Architecture & Safety Validator
#
# Usage:
#   ./scripts/harness/validate.sh           # check all tracked files
#   ./scripts/harness/validate.sh --staged  # check only git-staged files (pre-commit mode)
#
# Exit codes:
#   0 — all checks passed
#   1 — one or more violations found
#
# Checks:
#   1. Hardcoded secrets (API key patterns)
#   2. Dangerous shell commands (rm -rf /, force push to main)
#   3. Architecture violations (domain/ importing from other layers; also legacy infrastructure/ rule)
#   4. File length cap (CONSTRAINTS.md §5: no single file over 500 lines)
#   5. Test coverage thresholds (v0.2 merge gate — see docs/plans/v0-2-bigbang-design.md §5.6/§7)
#
# Opt-outs:
#   SKIP_COVERAGE=1 ./scripts/harness/validate.sh   # skip Check 5 for fast local iteration
#                                                    # (CI must leave this unset)
#
# References:
#   docs/harness/SAFETY.md     — secret management, safety rails
#   docs/architecture/CONSTRAINTS.md — forbidden patterns
#   docs/harness/ENTROPY.md    — lint as AI-slop prevention
#
# chmod +x scripts/harness/validate.sh

set -e
set -u

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
YLW='\033[0;33m'
GRN='\033[0;32m'
BLU='\033[0;34m'
RST='\033[0m'

info()    { printf "${BLU}[validate]${RST} %s\n" "$*"; }
ok()      { printf "${GRN}[ok]${RST}       %s\n" "$*"; }
warn()    { printf "${YLW}[warn]${RST}     %s\n" "$*" >&2; }
violation() {
  printf "${RED}[VIOLATION]${RST} %s\n" "$*" >&2
}

# ── Mode: staged files only, or all tracked files ─────────────────────────────
MODE="${1:-}"
if [ "${MODE}" = "--staged" ]; then
  # Pre-commit mode: only check files staged for this commit
  FILES=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)
else
  # CI / manual mode: check all files tracked by git
  FILES=$(git ls-files 2>/dev/null || true)
fi

if [ -z "${FILES}" ]; then
  ok "No files to validate."
  exit 0
fi

info "Mode: ${MODE:-all-tracked}"
info "Files to check: $(echo "${FILES}" | wc -l | tr -d ' ')"

VIOLATIONS=0

# ── Helper: grep a file list for a pattern and report violations ──────────────
# Usage: check_pattern DESCRIPTION PATTERN [FILE_GLOB]
check_pattern() {
  local description="$1"
  local pattern="$2"
  local file_filter="${3:-}"

  while IFS= read -r file; do
    # Skip non-existent files (deleted in staged set)
    [ -f "${file}" ] || continue

    # Apply optional file-type filter
    if [ -n "${file_filter}" ]; then
      case "${file}" in
        ${file_filter}) ;;
        *) continue ;;
      esac
    fi

    # grep -n: line numbers; -P: Perl regex (fall back to -E if unavailable)
    local matches
    if grep -qP "${pattern}" "${file}" 2>/dev/null; then
      matches=$(grep -nP "${pattern}" "${file}" 2>/dev/null || true)
    elif grep -qE "${pattern}" "${file}" 2>/dev/null; then
      matches=$(grep -nE "${pattern}" "${file}" 2>/dev/null || true)
    else
      continue
    fi

    if [ -n "${matches}" ]; then
      violation "${description}"
      while IFS= read -r match_line; do
        violation "  ${file}:${match_line}"
      done <<< "${matches}"
      VIOLATIONS=$(( VIOLATIONS + 1 ))
    fi
  done <<< "${FILES}"
}

# ─────────────────────────────────────────────────────────────────────────────
# CHECK 1: Hardcoded secrets
# Detects common API key / token patterns that should never appear in code.
# Reference: docs/harness/SAFETY.md section 1, CONSTRAINTS.md section 3
# ─────────────────────────────────────────────────────────────────────────────
info "Check 1/5: Hardcoded secrets"

# Exclude .env.example (it shows key names only, not values),
# this script itself, and binary/lock files.
EXCLUDE_SECRET_FILES=".env.example|scripts/harness/validate.sh|package-lock.json|yarn.lock|go.sum|poetry.lock"

while IFS= read -r file; do
  [ -f "${file}" ] || continue

  # Skip excluded files
  case "${file}" in
    .env.example|scripts/harness/validate.sh|package-lock.json|yarn.lock|go.sum|poetry.lock)
      continue ;;
    *.png|*.jpg|*.jpeg|*.gif|*.ico|*.woff|*.woff2|*.ttf|*.eot)
      continue ;;
  esac

  # Patterns that indicate a real secret value (not a placeholder)
  SECRET_PATTERNS=(
    # Linear API key with actual value
    'lin_api_[A-Za-z0-9]{20,}'
    # Generic "key = <value>" assignments (not empty, not placeholder)
    'API_KEY\s*=\s*["\x27][A-Za-z0-9_\-]{16,}["\x27]'
    'API_SECRET\s*=\s*["\x27][A-Za-z0-9_\-]{16,}["\x27]'
    'ACCESS_TOKEN\s*=\s*["\x27][A-Za-z0-9_\-\.]{16,}["\x27]'
    'PRIVATE_KEY\s*=\s*["\x27][A-Za-z0-9_\-]{16,}["\x27]'
    # AWS
    'AKIA[0-9A-Z]{16}'
    # GitHub tokens
    'ghp_[A-Za-z0-9]{36}'
    'github_pat_[A-Za-z0-9_]{82}'
    # Generic high-entropy bearer tokens in source code
    'Bearer\s+[A-Za-z0-9\._\-]{32,}'
  )

  for pattern in "${SECRET_PATTERNS[@]}"; do
    matches=""
    if grep -qE "${pattern}" "${file}" 2>/dev/null; then
      matches=$(grep -nE "${pattern}" "${file}" 2>/dev/null || true)
    fi
    if [ -n "${matches}" ]; then
      violation "Hardcoded secret detected (pattern: ${pattern})"
      violation "  Fix: Move the value to .env and reference it via environment variable."
      violation "  See: docs/architecture/CONSTRAINTS.md section 3"
      while IFS= read -r match_line; do
        violation "  ${file}:${match_line}"
      done <<< "${matches}"
      VIOLATIONS=$(( VIOLATIONS + 1 ))
    fi
  done
done <<< "${FILES}"

[ "${VIOLATIONS}" -eq 0 ] && ok "No hardcoded secrets found" || true

# ─────────────────────────────────────────────────────────────────────────────
# CHECK 2: Dangerous shell commands
# Reference: docs/harness/SAFETY.md section 1, AGENTS.md section 3 Security
# ─────────────────────────────────────────────────────────────────────────────
info "Check 2/5: Dangerous shell commands"

VIOLATIONS_BEFORE_2="${VIOLATIONS}"

while IFS= read -r file; do
  [ -f "${file}" ] || continue

  # Only check shell scripts and CI YAML
  case "${file}" in
    *.sh|*.bash|*.zsh|.github/workflows/*.yml|.github/workflows/*.yaml) ;;
    *) continue ;;
  esac

  # Skip this script itself (contains patterns as detection strings)
  case "${file}" in
    scripts/harness/validate.sh) continue ;;
  esac

  # rm -rf with filesystem root or workspace root
  if grep -qE 'rm\s+-[rf]{1,2}\s+/' "${file}" 2>/dev/null; then
    matches=$(grep -nE 'rm\s+-[rf]{1,2}\s+/' "${file}" 2>/dev/null || true)
    if [ -n "${matches}" ]; then
      violation "Dangerous: rm -rf with absolute path root"
      violation "  Fix: Use a scoped path variable, never start from / or \$HOME directly."
      violation "  See: docs/harness/SAFETY.md section 1"
      while IFS= read -r match_line; do
        violation "  ${file}:${match_line}"
      done <<< "${matches}"
      VIOLATIONS=$(( VIOLATIONS + 1 ))
    fi
  fi

  # git push --force to main or master
  if grep -qE 'git\s+push\s+.*--force.*\s+(main|master)' "${file}" 2>/dev/null || \
     grep -qE 'git\s+push\s+.*-f\s+.*(main|master)' "${file}" 2>/dev/null; then
    matches=$(grep -nE 'git\s+push\s+.*(--force|-f).*(main|master)' "${file}" 2>/dev/null || true)
    if [ -n "${matches}" ]; then
      violation "Dangerous: git push --force to main/master"
      violation "  Fix: Never force-push to main or master."
      violation "  See: docs/harness/SAFETY.md section 1, AGENTS.md section 3"
      while IFS= read -r match_line; do
        violation "  ${file}:${match_line}"
      done <<< "${matches}"
      VIOLATIONS=$(( VIOLATIONS + 1 ))
    fi
  fi

  # git push --force without branch name (could target current branch = main)
  if grep -qE 'git\s+push\s+(--force|-f)\s*$' "${file}" 2>/dev/null; then
    matches=$(grep -nE 'git\s+push\s+(--force|-f)\s*$' "${file}" 2>/dev/null || true)
    if [ -n "${matches}" ]; then
      violation "Dangerous: bare git push --force (ambiguous target branch)"
      violation "  Fix: Always specify target branch explicitly and confirm it is not main."
      while IFS= read -r match_line; do
        violation "  ${file}:${match_line}"
      done <<< "${matches}"
      VIOLATIONS=$(( VIOLATIONS + 1 ))
    fi
  fi
done <<< "${FILES}"

[ "${VIOLATIONS}" -eq "${VIOLATIONS_BEFORE_2}" ] && ok "No dangerous shell commands found" || true

# ─────────────────────────────────────────────────────────────────────────────
# CHECK 3: Architecture violations — domain/ importing from infrastructure/
# Reference: docs/architecture/CONSTRAINTS.md section 1
#            docs/architecture/LAYERS.md
# ─────────────────────────────────────────────────────────────────────────────
info "Check 3/5: Architecture layer violations (domain must be pure)"

VIOLATIONS_BEFORE_3="${VIOLATIONS}"

# Layer directories this project actually uses. Domain must not import any of them.
# Matched against relative import specifiers inside files under */domain/*.
NON_DOMAIN_LAYER_DIRS="tracker|workspace|sessions|observability|config|orchestrator|relay|server|infrastructure"

while IFS= read -r file; do
  [ -f "${file}" ] || continue

  # Only check files inside a domain/ directory subtree
  case "${file}" in
    */domain/*|domain/*) ;;
    *) continue ;;
  esac

  # TypeScript / JavaScript: domain imports any non-domain layer directory.
  # Exclude relative imports that stay inside domain/ (e.g. "./ports/tracker"
  # from domain/parsed-webhook-event.ts is a within-domain reference, not an
  # outbound dependency). Relative imports that escape the domain subtree
  # would need "../../" and would not match this check's starting anchor.
  if grep -qE "from ['\"][^'\"]*(/|^)(${NON_DOMAIN_LAYER_DIRS})(/|['\"])" "${file}" 2>/dev/null; then
    matches=$(grep -nE "from ['\"][^'\"]*(/|^)(${NON_DOMAIN_LAYER_DIRS})(/|['\"])" "${file}" 2>/dev/null \
      | grep -vE "from ['\"]\./" || true)
    if [ -n "${matches}" ]; then
      violation "Architecture violation: domain/ imports from non-domain layer"
      violation "  Fix: Domain must be pure. Define an interface in domain/, implement it in the outer layer, and inject it."
      violation "  See: docs/architecture/LAYERS.md, docs/architecture/CONSTRAINTS.md section 1"
      while IFS= read -r match_line; do
        violation "  ${file}:${match_line}"
      done <<< "${matches}"
      VIOLATIONS=$(( VIOLATIONS + 1 ))
    fi
  fi

  # Legacy: some older stacks still use an infrastructure/ dir name — keep the check.
  if grep -qE "from ['\"].*infrastructure" "${file}" 2>/dev/null; then
    matches=$(grep -nE "from ['\"].*infrastructure" "${file}" 2>/dev/null || true)
    if [ -n "${matches}" ]; then
      violation "Architecture violation: domain/ imports from infrastructure/"
      violation "  Fix: Domain layer must not depend on infrastructure."
      violation "  Move the dependency inversion — define an interface in domain/, implement it in infrastructure/."
      violation "  See: docs/architecture/CONSTRAINTS.md section 1"
      while IFS= read -r match_line; do
        violation "  ${file}:${match_line}"
      done <<< "${matches}"
      VIOLATIONS=$(( VIOLATIONS + 1 ))
    fi
  fi

  # Python: import from infrastructure
  if grep -qE "^(from|import)\s+.*infrastructure" "${file}" 2>/dev/null; then
    matches=$(grep -nE "^(from|import)\s+.*infrastructure" "${file}" 2>/dev/null || true)
    if [ -n "${matches}" ]; then
      violation "Architecture violation: domain/ imports from infrastructure/ (Python)"
      violation "  Fix: Use dependency inversion — define abstract interface in domain/, inject concrete impl."
      violation "  See: docs/architecture/CONSTRAINTS.md section 1, docs/architecture/enforcement/python.md"
      while IFS= read -r match_line; do
        violation "  ${file}:${match_line}"
      done <<< "${matches}"
      VIOLATIONS=$(( VIOLATIONS + 1 ))
    fi
  fi

  # Go: import path contains /infrastructure
  if grep -qE '"[^"]+/infrastructure[^"]*"' "${file}" 2>/dev/null; then
    matches=$(grep -nE '"[^"]+/infrastructure[^"]*"' "${file}" 2>/dev/null || true)
    if [ -n "${matches}" ]; then
      violation "Architecture violation: domain/ imports from infrastructure/ (Go)"
      violation "  Fix: Define interfaces in domain/, inject infrastructure implementations via constructors."
      violation "  See: docs/architecture/CONSTRAINTS.md section 1, docs/architecture/enforcement/go.md"
      while IFS= read -r match_line; do
        violation "  ${file}:${match_line}"
      done <<< "${matches}"
      VIOLATIONS=$(( VIOLATIONS + 1 ))
    fi
  fi

  # Python: ORM or external SDK imported in domain/
  if grep -qE "^(from|import)\s+(sqlalchemy|django\.db|peewee|tortoise|motor|pymongo|linear_sdk)" "${file}" 2>/dev/null; then
    matches=$(grep -nE "^(from|import)\s+(sqlalchemy|django\.db|peewee|tortoise|motor|pymongo|linear_sdk)" "${file}" 2>/dev/null || true)
    if [ -n "${matches}" ]; then
      violation "Architecture violation: ORM or external SDK imported in domain/ (Python)"
      violation "  Fix: Domain layer must be pure. Move persistence logic to infrastructure/."
      violation "  See: docs/architecture/CONSTRAINTS.md section 1"
      while IFS= read -r match_line; do
        violation "  ${file}:${match_line}"
      done <<< "${matches}"
      VIOLATIONS=$(( VIOLATIONS + 1 ))
    fi
  fi

done <<< "${FILES}"

[ "${VIOLATIONS}" -eq "${VIOLATIONS_BEFORE_3}" ] && ok "No architecture layer violations found" || true

# ─────────────────────────────────────────────────────────────────────────────
# CHECK 4: File length cap (CONSTRAINTS.md §5 — no single file over 500 lines)
# ─────────────────────────────────────────────────────────────────────────────
info "Check 4/5: File length cap (CONSTRAINTS.md §5: max 500 lines per file)"

VIOLATIONS_BEFORE_4="${VIOLATIONS}"
MAX_LINES=500

# Grandfathered files: pre-existing violations tracked in docs/plans/architecture-debt.md.
# Each entry is "path:ceiling" — fail only if the file grows above its ceiling.
# Shrink the ceiling as you split these files; delete the entry when it drops under MAX_LINES.
# (Currently empty — all prior entries were split below the 500-line cap.)
GRANDFATHERED=()

get_ceiling() {
  local path="$1"
  # Guard against empty arrays under bash 3.x + set -u on macOS.
  if [ "${#GRANDFATHERED[@]}" -gt 0 ]; then
    for entry in "${GRANDFATHERED[@]}"; do
      case "${entry}" in
        "${path}:"*) printf '%s' "${entry#*:}"; return 0 ;;
      esac
    done
  fi
  printf '%s' "${MAX_LINES}"
}

while IFS= read -r file; do
  [ -f "${file}" ] || continue

  # Scope: hand-written code files only. Skip generated, vendored, binary, docs.
  case "${file}" in
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.py|*.go|*.rs) ;;
    *) continue ;;
  esac
  case "${file}" in
    */node_modules/*|*/dist/*|*/build/*|*.d.ts|*/__tests__/*|*.test.ts|*.test.tsx|*.test.js) continue ;;
    apps/dashboard/src/lib/canvas/*|*/apps/dashboard/src/lib/canvas/*) continue ;;  # visual canvas code, not subject to backend SRP
  esac

  lines=$(wc -l < "${file}" | tr -d ' ')
  ceiling="$(get_ceiling "${file}")"
  if [ "${lines}" -gt "${ceiling}" ]; then
    if [ "${ceiling}" = "${MAX_LINES}" ]; then
      violation "File exceeds ${MAX_LINES}-line cap: ${file} has ${lines} lines"
      violation "  Fix: Split by responsibility. See CONSTRAINTS.md §5 for an example decomposition."
    else
      violation "Grandfathered file grew above its ceiling: ${file} has ${lines} lines (ceiling ${ceiling})"
      violation "  Fix: Do not add to this file until it is split. See CONSTRAINTS.md §5."
    fi
    VIOLATIONS=$(( VIOLATIONS + 1 ))
  fi
done <<< "${FILES}"

[ "${VIOLATIONS}" -eq "${VIOLATIONS_BEFORE_4}" ] && ok "No oversized files found" || true

# ─────────────────────────────────────────────────────────────────────────────
# CHECK 5: Test coverage thresholds (v0.2 merge gate).
# Reference: docs/plans/v0-2-bigbang-design.md §5.6 (coverage gate), §7 (merge
# gate checklist). Thresholds live in vitest.config.ts:coverage.thresholds.
#
# Skip with SKIP_COVERAGE=1 for fast local iteration. CI must leave this unset.
# ─────────────────────────────────────────────────────────────────────────────
info "Check 5/5: Test coverage thresholds"

if [ "${SKIP_COVERAGE:-0}" = "1" ]; then
  warn "SKIP_COVERAGE=1 set — skipping coverage gate. CI must not skip this check."
else
  VIOLATIONS_BEFORE_5="${VIOLATIONS}"

  # Coverage needs a working WORKSPACE_ROOT for workspace-manager tests.
  # Use a scratch directory if the caller has not set one.
  COVERAGE_WORKSPACE_ROOT="${WORKSPACE_ROOT:-}"
  if [ -z "${COVERAGE_WORKSPACE_ROOT}" ]; then
    COVERAGE_WORKSPACE_ROOT="$(mktemp -d -t av-validate-workspaces-XXXXXX)"
    export WORKSPACE_ROOT="${COVERAGE_WORKSPACE_ROOT}"
  fi

  if ! command -v bun >/dev/null 2>&1; then
    violation "bun not found on PATH — cannot run 'bun run test:coverage'."
    violation "  Fix: install bun (https://bun.sh) or set SKIP_COVERAGE=1 for local iteration only."
    VIOLATIONS=$(( VIOLATIONS + 1 ))
  else
    # Let vitest stream its own output — it already prints a structured
    # coverage table and the exact threshold that was missed.
    if ! bun run test:coverage; then
      violation "Coverage below threshold — see vitest summary above."
      violation "  Fix: add tests for the lines/branches reported as uncovered,"
      violation "       or justify a threshold change in vitest.config.ts:coverage.thresholds."
      violation "  Thresholds live in: vitest.config.ts"
      violation "  Design reference: docs/plans/v0-2-bigbang-design.md §5.6 / §7"
      VIOLATIONS=$(( VIOLATIONS + 1 ))
    fi
  fi

  [ "${VIOLATIONS}" -eq "${VIOLATIONS_BEFORE_5}" ] && ok "Coverage thresholds met" || true
fi

# ─────────────────────────────────────────────────────────────────────────────
# Result
# ─────────────────────────────────────────────────────────────────────────────
printf "\n"
if [ "${VIOLATIONS}" -eq 0 ]; then
  ok "All checks passed (0 violations)."
  exit 0
else
  violation "Total violations: ${VIOLATIONS}"
  violation "Fix all violations above and re-run: ./scripts/harness/validate.sh"
  exit 1
fi
