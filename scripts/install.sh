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
ASSUME_YES=false
INSTALL_WORKFLOWS=true
RUN_SETUP=true
HEADLESS=false
SETUP_ACTOR=""
SETUP_MODEL=""
SETUP_OMA=""
SETUP_ACTOR_SET=false
SETUP_MODEL_SET=false
SETUP_OMA_SET=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) ASSUME_YES=true; shift ;;
    --no-workflows) INSTALL_WORKFLOWS=false; shift ;;
    --no-setup) RUN_SETUP=false; shift ;;
    --headless) HEADLESS=true; shift ;;
    --actor)
      [[ "$SETUP_ACTOR_SET" == false ]] || { err "Pass --actor only once."; exit 1; }
      [[ $# -ge 2 && "${2-}" != -* ]] || { err "--actor requires a vendor. Run with --help."; exit 1; }
      SETUP_ACTOR="$2"
      SETUP_ACTOR_SET=true
      shift 2 ;;
    --model)
      [[ "$SETUP_MODEL_SET" == false ]] || { err "Pass --model only once."; exit 1; }
      [[ $# -ge 2 && "${2-}" != -* ]] || { err "--model requires a value; pass an empty string to clear a model pin."; exit 1; }
      SETUP_MODEL="$2"
      SETUP_MODEL_SET=true
      shift 2 ;;
    --oma)
      [[ "$SETUP_OMA_SET" == false ]] || { err "Pass --oma only once."; exit 1; }
      [[ $# -ge 2 && "${2-}" != -* ]] || { err "--oma requires prepare or skip."; exit 1; }
      SETUP_OMA="$2"
      SETUP_OMA_SET=true
      shift 2 ;;
    --help|-h)
      echo "Usage: bash install.sh [--yes] [--no-workflows] [--no-setup]"
      echo "       bash install.sh --headless [--actor <vendor>] [--model <model>] [--oma prepare|skip] [--no-workflows]"
      echo "Installs the harness and av CLI, then opens av setup --mode order in an interactive terminal."
      echo "--yes, --no-setup and CI defer the setup wizard; run av setup --mode order afterward."
      echo "--headless accepts installation answers and runs av setup --yes without a terminal, including CI."
      echo "Supply the calling agent's actor/model, or let setup resolve its trusted runtime or saved identity."
      echo "--model '' clears a saved model pin. OMA defaults to prepare; --oma skip defers it explicitly."
      echo "Installer output is progress text. Use av setup --yes --json separately for JSON results."
      exit 0 ;;
    *) err "Unknown option: $1. Run with --help for supported options."; exit 1 ;;
  esac
done
if [[ "$HEADLESS" == true && "$RUN_SETUP" != true ]]; then
  err "--headless cannot be combined with --no-setup. Choose unattended setup or setup deferral."
  exit 1
fi
if [[ "$HEADLESS" != true ]] && \
   [[ "$SETUP_ACTOR_SET" == true || "$SETUP_MODEL_SET" == true || "$SETUP_OMA_SET" == true ]]; then
  err "--actor, --model and --oma require --headless. For separate setup, use av setup --yes afterward."
  exit 1
fi
if [[ "$SETUP_ACTOR_SET" == true ]]; then
  case "$SETUP_ACTOR" in
    claude|codex|qwen|antigravity|cursor|grok|kimi|opencode) ;;
    *) err "Unsupported --actor '$SETUP_ACTOR'. Use claude, codex, qwen, antigravity, cursor, grok, kimi or opencode."; exit 1 ;;
  esac
fi
if [[ "$SETUP_MODEL_SET" == true && -n "$SETUP_MODEL" && -z "${SETUP_MODEL//[[:space:]]/}" ]]; then
  err "--model cannot contain only whitespace. Pass an empty string to clear a saved model pin."
  exit 1
fi
if [[ "$SETUP_OMA_SET" == true && "$SETUP_OMA" != prepare && "$SETUP_OMA" != skip ]]; then
  err "Unsupported --oma '$SETUP_OMA'. Use prepare or skip."
  exit 1
fi

# Detect whether we're running from inside the cloned repo
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "$PWD")"
IS_LOCAL=false
SOURCE_DIR=""

install_cli() {
  local options=("$SOURCE_DIR" "$TARGET_DIR" "$RUN_SETUP" "$ASSUME_YES")
  if [[ "$HEADLESS" == true ]]; then options+=(--headless); fi
  if [[ "$SETUP_ACTOR_SET" == true ]]; then options+=(--actor "$SETUP_ACTOR"); fi
  if [[ "$SETUP_MODEL_SET" == true ]]; then options+=(--model "$SETUP_MODEL"); fi
  if [[ "$SETUP_OMA_SET" == true ]]; then options+=(--oma "$SETUP_OMA"); fi
  bash "${SOURCE_DIR}/scripts/install-cli.sh" "${options[@]}"
}

if [[ -d "${SCRIPT_DIR}/../.agents" && -f "${SCRIPT_DIR}/../AGENTS.md" ]]; then
  IS_LOCAL=true
  SOURCE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
fi

if [[ "$IS_LOCAL" == true && "$SOURCE_DIR" == "$(pwd -P)" ]]; then
  info "Agent Valley is already cloned here; the harness files are present."
  install_cli
  exit 0
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
    if ! grep -qxF -- "$line" "$dst"; then
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
  if [[ "$ASSUME_YES" == true || "$HEADLESS" == true ]]; then return 0; fi
  if [[ -n "${CI:-}" ]]; then
    err "CI cannot answer installer prompts. Run bash install.sh --yes --no-setup."
    exit 1
  fi
  # stdin may contain this script (curl | bash). Never read answers from it.
  if ! { printf '  %s %s ' "$prompt" "$hint" > /dev/tty; read -r answer < /dev/tty; } 2>/dev/null; then
    err "No interactive terminal. Run bash install.sh --yes (optionally --no-workflows)."
    exit 1
  fi
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
  SOURCE_DIR="${AGENT_VALLEY_INSTALL_DIR:-${XDG_DATA_HOME:-${HOME}/.local/share}/agent-valley}"
  if [[ "$SOURCE_DIR" != /* ]]; then
    err "AGENT_VALLEY_INSTALL_DIR must be an absolute path. Set it to a persistent Agent Valley checkout."
    exit 1
  fi
  if [[ -e "$SOURCE_DIR" ]]; then
    if [[ ! -d "${SOURCE_DIR}/.git" || ! -f "${SOURCE_DIR}/apps/cli/src/index.ts" ]] || \
       [[ "$(git -C "$SOURCE_DIR" remote get-url origin)" != "$REPO_URL" ]]; then
      err "$SOURCE_DIR is not an Agent Valley checkout. Choose an empty AGENT_VALLEY_INSTALL_DIR; existing files were retained."
      exit 1
    fi
    if [[ -n "$(git -C "$SOURCE_DIR" status --porcelain)" ]]; then
      err "$SOURCE_DIR has local changes. Keep them and select another AGENT_VALLEY_INSTALL_DIR, or install from that local checkout."
      exit 1
    fi
    info "Updating the installed Agent Valley checkout..."
    git -C "$SOURCE_DIR" pull --ff-only --quiet
  else
    info "Fetching Agent Valley into $SOURCE_DIR..."
    mkdir -p "$(dirname "$SOURCE_DIR")"
    git clone --depth 1 --quiet "$REPO_URL" "$SOURCE_DIR"
  fi
  success "Agent Valley source ready."
  echo ""
fi

# A piped installer can also target the persistent checkout itself.
if [[ "$(cd "$SOURCE_DIR" && pwd -P)" == "$(pwd -P)" ]]; then
  info "The Agent Valley checkout already contains the harness."
  install_cli
  exit 0
fi

# ═════════════════════════════════════════════════════════════════════════════
# [1/3] Harness core — always installed regardless of mode
# ═════════════════════════════════════════════════════════════════════════════
echo -e "${BOLD}  [1/3] Harness core${RESET}"
echo ""

copy_dir  ".agents"
copy_dir  ".claude"
copy_dir  ".codex"
copy_dir  ".cursor"
copy_dir  ".grok"
# antigravity uses a global CLI harness (~/.gemini/antigravity-cli/), not a
# project dir, so it is intentionally not copied here.
# kimi does NOT get a copy_dir either: its harness dir (.kimi-code/) only
# holds mcp.json from `oma link kimi`, not a full skills dir. kimi natively
# auto-discovers the copied `.agents/skills/` as a project skill dir at
# spawn time — no copy_dir and no --skills-dir flag needed.
# opencode is NOT copied either: its `.opencode/` harness ships a bun plugin
# with a ~61MB node_modules + lockfiles (gitignored, regenerable). Copying it
# would bloat every target repo. Run `oma link opencode` in the target to
# generate `.opencode/` (plugins + agents) with its deps instead.
copy_dir  "docs"

mkdir -p "${TARGET_DIR}/scripts/harness"
copy_file "scripts/harness/gc.sh"
copy_file "scripts/harness/validate.sh"
chmod +x \
  "${TARGET_DIR}/scripts/harness/gc.sh" \
  "${TARGET_DIR}/scripts/harness/validate.sh" 2>/dev/null || true

copy_file "av.example.yaml"

echo ""

# ═════════════════════════════════════════════════════════════════════════════
# [2/3] Mode-specific install
# ═════════════════════════════════════════════════════════════════════════════
if [[ "$MODE" == "existing" ]]; then
  echo -e "${BOLD}  [2/3] Merging into existing project${RESET}"
  echo ""

  # AGENTS.md ─ append Symphony section if file already exists
  if [[ -f "${TARGET_DIR}/AGENTS.md" ]] && grep -qxF '## Symphony Harness' "${TARGET_DIR}/AGENTS.md"; then
    info "Skipped AGENTS.md (Symphony Harness section already present)"
  elif [[ -f "${TARGET_DIR}/AGENTS.md" ]]; then
    warn "AGENTS.md exists — appending Symphony Harness section"
    {
      echo ""
      echo "---"
      echo ""
      echo "## Symphony Harness"
      echo ""
      echo "This project uses the [Agent Valley harness](https://github.com/first-fluke/agent-valley)."
      echo "See \`av.example.yaml\` and \`docs/specs/\` for configuration and component specifications."
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

if [[ "$INSTALL_WORKFLOWS" == true ]] && ask "Add .github/ workflows and PR template?" N; then
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
install_cli
echo "  Review AGENTS.md and the copied docs for your project's conventions."
echo ""
echo "  Docs: https://github.com/first-fluke/agent-valley"
echo ""
