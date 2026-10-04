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
export PATH="$(dirname "$NODE_BIN"):$(dirname "$BUN_BIN"):${BIN_DIR}:${PATH}"

say "Installing locked CLI dependencies."
(cd "$CHECKOUT" && "$BUN_BIN" install --frozen-lockfile --ignore-scripts </dev/null)
mkdir -p "$BIN_DIR"
{
  printf '#!/usr/bin/env bash\n%s\nset -euo pipefail\n' "$MARKER"
  printf 'export PATH=%q:%q:%q:"$PATH"\n' "$(dirname "$NODE_BIN")" "$(dirname "$BUN_BIN")" "$BIN_DIR"
  printf 'exec %q run %q "$@"\n' "$BUN_BIN" "${CHECKOUT}/apps/cli/src/index.ts"
} > "$AV_BIN"
chmod +x "$AV_BIN"
say "Installed av at $AV_BIN."
case ":${INSTALLER_CALLER_PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *) printf '[agent-valley] Add av to your shell PATH: export PATH=%q:"$PATH"\n' "$BIN_DIR" ;;
esac

say "Installing project AV skills and MCP configuration for Codex, Claude Code, Cursor, Qwen Code, and Antigravity."
(cd "$PROJECT" && "$AV_BIN" integrations install --workspace "$PROJECT" </dev/null) || \
  fail "av is installed, but project client integrations are incomplete. Keep conflicting files and rerun av integrations install --workspace $(printf '%q' "$PROJECT") after resolving the reported conflict."

defer_setup() {
  say "Setup deferred. Run this command from your target repository:"
  printf '  %q setup --mode order\n' "$AV_BIN"
}
if [[ "$RUN_SETUP" != true || "$ASSUME_YES" == true || -n "${CI:-}" ]]; then
  defer_setup
elif [[ -t 0 ]]; then
  (cd "$PROJECT" && "$AV_BIN" setup --mode order)
elif { : </dev/tty; } 2>/dev/null; then
  # curl | bash owns stdin; reconnect both prompt streams to the terminal.
  (cd "$PROJECT" && "$AV_BIN" setup --mode order </dev/tty >/dev/tty)
else
  defer_setup
fi
