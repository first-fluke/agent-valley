#!/usr/bin/env bash
# Source launcher installation; no compilation or package publication.
set -euo pipefail

CHECKOUT="${1:?Persistent Agent Valley checkout is required}"
PROJECT="${2:?Target project is required}"
RUN_SETUP="${3:-true}"
ASSUME_YES="${4:-false}"
BIN_DIR="${AGENT_VALLEY_BIN_DIR:-${HOME}/.local/bin}"
AV_BIN="${BIN_DIR}/av"
INSTALLER_CALLER_PATH="${PATH}"
MARKER='# Agent Valley source launcher'

say() { printf '[agent-valley] %s\n' "$*"; }
fail() { say "$*" >&2; exit 1; }
shift "$(( $# < 4 ? $# : 4 ))"
HEADLESS=false
SETUP_ACTOR=""
SETUP_MODEL=""
SETUP_OMA=""
SETUP_ACTOR_SET=false
SETUP_MODEL_SET=false
SETUP_OMA_SET=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --headless) HEADLESS=true; shift ;;
    --actor)
      [[ "$SETUP_ACTOR_SET" == false ]] || fail "Pass --actor only once."
      [[ $# -ge 2 && "${2-}" != -* ]] || fail "--actor requires a vendor."
      SETUP_ACTOR="$2"; SETUP_ACTOR_SET=true; shift 2 ;;
    --model)
      [[ "$SETUP_MODEL_SET" == false ]] || fail "Pass --model only once."
      [[ $# -ge 2 && "${2-}" != -* ]] || fail "--model requires a value; pass an empty string to clear a model pin."
      SETUP_MODEL="$2"; SETUP_MODEL_SET=true; shift 2 ;;
    --oma)
      [[ "$SETUP_OMA_SET" == false ]] || fail "Pass --oma only once."
      [[ $# -ge 2 && "${2-}" != -* ]] || fail "--oma requires prepare or skip."
      SETUP_OMA="$2"; SETUP_OMA_SET=true; shift 2 ;;
    *) fail "Unknown installer setup option: $1." ;;
  esac
done
[[ "$RUN_SETUP" == true || "$RUN_SETUP" == false ]] || fail "The installer setup switch must be true or false."
[[ "$ASSUME_YES" == true || "$ASSUME_YES" == false ]] || fail "The installer answer switch must be true or false."
if [[ "$HEADLESS" == true && "$RUN_SETUP" != true ]]; then
  fail "--headless cannot be combined with setup deferral."
fi
if [[ "$HEADLESS" != true ]] && \
   [[ "$SETUP_ACTOR_SET" == true || "$SETUP_MODEL_SET" == true || "$SETUP_OMA_SET" == true ]]; then
  fail "--actor, --model and --oma require --headless."
fi
if [[ "$SETUP_ACTOR_SET" == true ]]; then
  case "$SETUP_ACTOR" in
    claude|codex|qwen|antigravity|cursor|grok|kimi|opencode) ;;
    *) fail "Unsupported --actor '$SETUP_ACTOR'. Use claude, codex, qwen, antigravity, cursor, grok, kimi or opencode." ;;
  esac
fi
if [[ "$SETUP_MODEL_SET" == true && -n "$SETUP_MODEL" && -z "${SETUP_MODEL//[[:space:]]/}" ]]; then
  fail "--model cannot contain only whitespace. Pass an empty string to clear a saved model pin."
fi
if [[ "$SETUP_OMA_SET" == true && "$SETUP_OMA" != prepare && "$SETUP_OMA" != skip ]]; then
  fail "Unsupported --oma '$SETUP_OMA'. Use prepare or skip."
fi
[[ "$BIN_DIR" == /* ]] || fail "AGENT_VALLEY_BIN_DIR must be an absolute path."
[[ -f "${CHECKOUT}/apps/cli/src/index.ts" && -f "${CHECKOUT}/bun.lock" ]] || \
  fail "Agent Valley CLI source or bun.lock is missing in $CHECKOUT. Install from a complete Agent Valley checkout."
if [[ -e "$AV_BIN" || -L "$AV_BIN" ]]; then
  if [[ -L "$AV_BIN" || ! -f "$AV_BIN" ]] || ! grep -qxF "$MARKER" "$AV_BIN"; then
    fail "$AV_BIN already exists and is not this installer's launcher. Keep it and choose another AGENT_VALLEY_BIN_DIR."
  fi
fi

NODE_REQUIRED="$(tr -d '[:space:]' < "${CHECKOUT}/.node-version")"
BUN_REQUIRED="$(sed -nE 's/.*"packageManager"[[:space:]]*:[[:space:]]*"bun@([^"]+)".*/\1/p' "${CHECKOUT}/package.json")"
[[ "$NODE_REQUIRED" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$BUN_REQUIRED" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || \
  fail "Restore .node-version and package.json packageManager with the required Node and Bun versions."

version_at_least() {
  local actual="${1#v}" required="$2" a b c x y z
  [[ "$actual" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  IFS=. read -r a b c <<< "$actual"
  IFS=. read -r x y z <<< "$required"
  (( a > x || (a == x && b > y) || (a == x && b == y && c >= z) ))
}

NODE_BIN="$(command -v node || true)"
BUN_BIN="$(command -v bun || true)"
if [[ "$NODE_BIN" == */shims/node || "$BUN_BIN" == */shims/bun ]] || \
   ! version_at_least "$("${NODE_BIN:-false}" --version 2>/dev/null || true)" "$NODE_REQUIRED" || \
   ! version_at_least "$("${BUN_BIN:-false}" --version 2>/dev/null || true)" "$BUN_REQUIRED"; then
  MISE_BIN="$(command -v mise || true)"
  if [[ -z "$MISE_BIN" && -x "${HOME}/.local/bin/mise" ]]; then MISE_BIN="${HOME}/.local/bin/mise"; fi
  if [[ -z "$MISE_BIN" ]]; then
    say "Installing mise to provision Node $NODE_REQUIRED and Bun $BUN_REQUIRED."
    # Official installer: https://mise.jdx.dev/getting-started.html
    command -v curl >/dev/null || fail "Install curl, then rerun the Agent Valley installer."
    curl -fsSL https://mise.run | sh
    MISE_BIN="${HOME}/.local/bin/mise"
  fi
  say "Provisioning Node $NODE_REQUIRED and Bun $BUN_REQUIRED with mise."
  "$MISE_BIN" --yes install "node@${NODE_REQUIRED}" "bun@${BUN_REQUIRED}" </dev/null
  NODE_BIN="$("$MISE_BIN" where "node@${NODE_REQUIRED}")/bin/node"
  BUN_BIN="$("$MISE_BIN" where "bun@${BUN_REQUIRED}")/bin/bun"
fi
version_at_least "$("$NODE_BIN" --version)" "$NODE_REQUIRED" || fail "Node $NODE_REQUIRED or newer is required. Rerun the installer after fixing the runtime."
version_at_least "$("$BUN_BIN" --version)" "$BUN_REQUIRED" || fail "Bun $BUN_REQUIRED or newer is required. Rerun the installer after fixing the runtime."
PATH="$(dirname "$NODE_BIN"):$(dirname "$BUN_BIN"):${BIN_DIR}:${PATH}"
export PATH

say "Installing locked CLI dependencies."
(cd "$CHECKOUT" && "$BUN_BIN" install --frozen-lockfile --ignore-scripts </dev/null)
mkdir -p "$BIN_DIR"
{
  printf '#!/usr/bin/env bash\n%s\nset -euo pipefail\n' "$MARKER"
  # Keep PATH expansion literal for the generated launcher's runtime.
  # shellcheck disable=SC2016
  printf 'export PATH=%q:%q:%q:"$PATH"\n' "$(dirname "$NODE_BIN")" "$(dirname "$BUN_BIN")" "$BIN_DIR"
  printf 'exec %q run %q "$@"\n' "$BUN_BIN" "${CHECKOUT}/apps/cli/src/index.ts"
} > "$AV_BIN"
chmod +x "$AV_BIN"
say "Installed av at $AV_BIN."
case ":${INSTALLER_CALLER_PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *)
    # Keep PATH expansion literal in the operator's copyable command.
    # shellcheck disable=SC2016
    printf '[agent-valley] Add av to your shell PATH: export PATH=%q:"$PATH"\n' "$BIN_DIR" ;;
esac

if [[ "$HEADLESS" != true ]]; then
  say "Installing project AV skills and MCP configuration for Codex, Claude Code, Cursor, Qwen Code, and Antigravity."
  (cd "$PROJECT" && "$AV_BIN" integrations install --workspace "$PROJECT" </dev/null) || \
    fail "av is installed, but project client integrations are incomplete. Keep conflicting files and rerun av integrations install --workspace $(printf '%q' "$PROJECT") after resolving the reported conflict."
fi

defer_setup() {
  say "Setup deferred. Run this command from your target repository:"
  printf '  %q setup --mode order\n' "$AV_BIN"
}
if [[ "$HEADLESS" == true ]]; then
  SETUP_ARGS=(setup --yes --workspace "$PROJECT")
  if [[ "$SETUP_ACTOR_SET" == true ]]; then SETUP_ARGS+=(--actor "$SETUP_ACTOR"); fi
  if [[ "$SETUP_MODEL_SET" == true ]]; then SETUP_ARGS+=(--model "$SETUP_MODEL"); fi
  if [[ "$SETUP_OMA_SET" == true ]]; then SETUP_ARGS+=(--oma "$SETUP_OMA"); fi
  say "Running unattended AV setup. Project integrations are prepared by setup."
  (cd "$PROJECT" && "$AV_BIN" "${SETUP_ARGS[@]}" </dev/null)
elif [[ "$RUN_SETUP" != true || "$ASSUME_YES" == true || -n "${CI:-}" ]]; then
  defer_setup
elif [[ -t 0 ]]; then
  (cd "$PROJECT" && "$AV_BIN" setup --mode order)
elif { : </dev/tty; } 2>/dev/null; then
  # curl | bash owns stdin; reconnect both prompt streams to the terminal.
  (cd "$PROJECT" && "$AV_BIN" setup --mode order </dev/tty >/dev/tty)
else
  defer_setup
fi
