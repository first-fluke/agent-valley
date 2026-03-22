#!/usr/bin/env bash
# scripts/install.sh — Agent Valley Symphony Harness Installer
#
# Usage (new project, local):
#   ./scripts/install.sh
#
# Usage (existing project, remote):
#   curl -fsSL https://raw.githubusercontent.com/first-fluke/agent-valley/main/scripts/install.sh | bash
#
set -euo pipefail

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
RESET='\033[0m'

info()    { echo -e "${BLUE}[agent-valley]${RESET} $*"; }
success() { echo -e "${GREEN}[agent-valley]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[agent-valley]${RESET} $*"; }
err()     { echo -e "${RED}[agent-valley]${RESET} $*" >&2; }

REPO_URL="https://github.com/first-fluke/agent-valley.git"
TARGET_DIR="${PWD}"

# Detect whether we're running from inside the cloned repo
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "$PWD")"
IS_LOCAL=false
SOURCE_DIR=""

if [[ -d "${SCRIPT_DIR}/../.agents" && -f "${SCRIPT_DIR}/../AGENTS.md" ]]; then
  IS_LOCAL=true
  SOURCE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
fi

# ── Detect project type ───────────────────────────────────────────────────────
detect_project_type() {
  local dir="${1:-$TARGET_DIR}"
  if [[ -f "${dir}/package.json" ]] || \
     [[ -f "${dir}/pyproject.toml" ]] || \
     [[ -f "${dir}/go.mod" ]] || \
     [[ -f "${dir}/Cargo.toml" ]] || \
     [[ -f "${dir}/pom.xml" ]]; then
    echo "existing"
  else
    echo "new"
  fi
}

# ── Helpers ───────────────────────────────────────────────────────────────────
copy_dir() {
  local rel="$1"
  local src="${SOURCE_DIR}/${rel}"
  local dst="${TARGET_DIR}/${rel}"
  if [[ -d "$src" ]]; then
    mkdir -p "$dst"
    cp -r "${src}/." "$dst/"
    success "Copied  ${rel}/"
  fi
}

copy_file() {
  local rel="$1"
  local src="${SOURCE_DIR}/${rel}"
  local dst="${TARGET_DIR}/${rel}"
  if [[ -f "$src" ]]; then
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    success "Copied  ${rel}"
  fi
}

# Append lines from src that are not already present in dst.
# Skips blank lines and comment-only lines during the dedup check.
append_if_missing() {
  local rel_src="$1"
  local rel_dst="${2:-$1}"
  local src="${SOURCE_DIR}/${rel_src}"
  local dst="${TARGET_DIR}/${rel_dst}"

  if [[ ! -f "$src" ]]; then return; fi
  if [[ ! -f "$dst" ]]; then
    cp "$src" "$dst"
    success "Created ${rel_dst}"
    return
  fi

  local added=0
  while IFS= read -r line; do
    # skip blank/comment lines for duplicate detection
    if [[ -z "${line//[[:space:]]/}" ]] || [[ "$line" == "#"* ]]; then continue; fi
    if ! grep -qF "$line" "$dst"; then
      echo "$line" >> "$dst"
      added=$((added + 1))
    fi
  done < "$src"

  if [[ $added -gt 0 ]]; then
    success "Updated ${rel_dst} (+${added} lines)"
  else
    info    "Skipped ${rel_dst} (already up to date)"
  fi
}

ask() {
  # ask <prompt> <default Y|N>  →  returns 0 (yes) or 1 (no)
  local prompt="$1"
  local default="${2:-Y}"
  local hint
  [[ "$default" == "Y" ]] && hint="[Y/n]" || hint="[y/N]"
  local answer
  read -r -p "  ${prompt} ${hint} " answer
  answer="${answer:-$default}"
  [[ "$answer" =~ ^[Yy]$ ]]
}

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  ♪ Agent Valley — Symphony Dev Harness Installer${RESET}"
echo "  ─────────────────────────────────────────────"
echo ""

PROJECT_TYPE="$(detect_project_type "$TARGET_DIR")"

if [[ "$PROJECT_TYPE" == "existing" ]]; then
  info "Detected ${BOLD}existing project${RESET} (build config found)"
  MODE="existing"
else
  info "Detected ${BOLD}new project${RESET} (no build config found)"
  MODE="new"
fi

echo ""
echo -e "  Mode:   ${BOLD}${MODE}${RESET}"
echo -e "  Target: ${BOLD}${TARGET_DIR}${RESET}"
echo ""

if ! ask "Proceed?" Y; then
  info "Aborted."
  exit 0
fi
echo ""

# ── Fetch source if not running locally ──────────────────────────────────────
if [[ "$IS_LOCAL" == false ]]; then
  TEMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TEMP_DIR"' EXIT

  info "Fetching agent-valley harness..."
  git clone --depth 1 --quiet "$REPO_URL" "$TEMP_DIR"
  SOURCE_DIR="$TEMP_DIR"
  success "Harness fetched."
  echo ""
fi

# ═════════════════════════════════════════════════════════════════════════════
# [1/3] Harness core — always installed regardless of mode
# ═════════════════════════════════════════════════════════════════════════════
echo -e "${BOLD}  [1/3] Harness core${RESET}"
echo ""

copy_dir  ".agents"
copy_dir  ".claude"
copy_dir  "docs"

mkdir -p "${TARGET_DIR}/scripts/harness"
copy_file "scripts/harness/gc.sh"
copy_file "scripts/harness/validate.sh"
chmod +x \
  "${TARGET_DIR}/scripts/harness/gc.sh" \
  "${TARGET_DIR}/scripts/harness/validate.sh" 2>/dev/null || true

copy_file "WORKFLOW.md"
copy_file ".env.example"

echo ""

# ═════════════════════════════════════════════════════════════════════════════
# [2/3] Mode-specific install
# ═════════════════════════════════════════════════════════════════════════════
if [[ "$MODE" == "existing" ]]; then
  echo -e "${BOLD}  [2/3] Merging into existing project${RESET}"
  echo ""

  # AGENTS.md ─ append Symphony section if file already exists
  if [[ -f "${TARGET_DIR}/AGENTS.md" ]]; then
    warn "AGENTS.md exists — appending Symphony Harness section"
    {
      echo ""
      echo "---"
      echo ""
      echo "## Symphony Harness"
      echo ""
      echo "This project uses the [Agent Valley harness](https://github.com/first-fluke/agent-valley)."
      echo "See \`WORKFLOW.md\` and \`docs/specs/\` for Symphony component specifications."
      echo "Run \`./scripts/harness/validate.sh\` to check architecture conformance."
    } >> "${TARGET_DIR}/AGENTS.md"
    success "Updated AGENTS.md (appended Symphony Harness section)"
  else
    copy_file "AGENTS.md"
  fi

  # CLAUDE.md ─ inject @AGENTS.md import if missing
  if [[ -f "${TARGET_DIR}/CLAUDE.md" ]]; then
    if ! grep -qF "@AGENTS.md" "${TARGET_DIR}/CLAUDE.md"; then
      echo "" >> "${TARGET_DIR}/CLAUDE.md"
      echo "@AGENTS.md" >> "${TARGET_DIR}/CLAUDE.md"
      success "Updated CLAUDE.md (added @AGENTS.md import)"
    else
      info    "Skipped CLAUDE.md (@AGENTS.md already imported)"
    fi
  else
    copy_file "CLAUDE.md"
  fi

  # .gitignore ─ append missing entries
  append_if_missing ".gitignore"

  echo ""
  echo -e "  ${YELLOW}Skipped:${RESET} src/, scripts/dev.sh, .github/ — not needed for existing project"

else
  # ── New project ─────────────────────────────────────────────────────────
  echo -e "${BOLD}  [2/3] New project scaffold${RESET}"
  echo ""

  copy_file "AGENTS.md"
  copy_file "CLAUDE.md"
  copy_file ".gitignore"
  copy_dir  "src"
  copy_file "scripts/dev.sh"
  chmod +x "${TARGET_DIR}/scripts/dev.sh" 2>/dev/null || true
fi

echo ""

# ═════════════════════════════════════════════════════════════════════════════
# [3/3] GitHub Actions (optional, asked for both modes)
# ═════════════════════════════════════════════════════════════════════════════
echo -e "${BOLD}  [3/3] GitHub Actions (optional)${RESET}"
echo ""
info "Includes: ci.yml, harness-gc.yml (weekly GC cron), PR template, pre-commit config"
echo ""

if ask "Add .github/ workflows and PR template?" Y; then
  copy_dir ".github"
else
  info "Skipped .github/"
fi

# ═════════════════════════════════════════════════════════════════════════════
# Done
# ═════════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${GREEN}${BOLD}  ✓ Agent Valley harness installed successfully${RESET}"
echo ""
echo "  Next steps:"
echo ""
if [[ ! -f "${TARGET_DIR}/.env" ]]; then
  echo "  1. cp .env.example .env"
  echo "     → Fill in LINEAR_API_KEY, LINEAR_TEAM_UUID, WORKSPACE_ROOT, etc."
  echo ""
  echo "  2. ./scripts/harness/validate.sh"
  echo "     → Verify architecture constraints and environment"
else
  echo "  1. ./scripts/harness/validate.sh"
  echo "     → Verify architecture constraints and environment"
fi
echo ""
echo "  3. Ask your agent to set up the implementation:"
echo "     Read AGENT_SETUP.md and scaffold a Symphony implementation using [TypeScript/Python/Go]."
echo ""
echo "  Docs: https://github.com/first-fluke/agent-valley"
echo ""
