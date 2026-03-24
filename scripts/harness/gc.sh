#!/usr/bin/env bash
# scripts/harness/gc.sh — Worktree Garbage Collector
#
# Usage:
#   ./scripts/harness/gc.sh
#
# Environment variables:
#   GC_DAYS         Retention period in days (default: 30)
#   DRY_RUN         If "true", list targets without deleting (default: false)
#   WORKSPACE_ROOT  Root directory for agent workspaces (optional)
#
# Soft-delete model (see docs/harness/ENTROPY.md section 2 — GC Patterns):
#   Run 1: Flags stale worktrees by writing .gc-flagged inside each worktree.
#   Run 2: Deletes worktrees that already carry the .gc-flagged marker.
#
# Safety:
#   - Never touches main, master, or trunk branches.
#   - Only processes branches with agent-created prefixes (feature/, fix/, refactor/, hotfix/, release/).
#   - Prints a summary report (also written to /tmp/gc-report-<timestamp>.txt).
#
# chmod +x scripts/harness/gc.sh

set -e
set -u

# ── Configuration ─────────────────────────────────────────────────────────────
GC_DAYS="${GC_DAYS:-30}"
DRY_RUN="${DRY_RUN:-false}"
REPORT_FILE="/tmp/gc-report-$(date +%Y%m%d-%H%M%S).txt"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
YLW='\033[0;33m'
GRN='\033[0;32m'
BLU='\033[0;34m'
RST='\033[0m'

info()  { printf "${BLU}[gc]${RST}   %s\n" "$*" | tee -a "${REPORT_FILE}"; }
ok()    { printf "${GRN}[ok]${RST}   %s\n" "$*" | tee -a "${REPORT_FILE}"; }
warn()  { printf "${YLW}[warn]${RST} %s\n" "$*" | tee -a "${REPORT_FILE}"; }
fail()  { printf "${RED}[fail]${RST} %s\n" "$*" | tee -a "${REPORT_FILE}" >&2; }

# ── Protected branches — never delete these ───────────────────────────────────
is_protected() {
  local branch="$1"
  case "${branch}" in
    main|master|trunk|develop|HEAD) return 0 ;;
    *) return 1 ;;
  esac
}

# ── Check if branch matches agent-created prefixes ───────────────────────────
# WorkspaceManager.deriveBranchName creates: feature/, fix/, refactor/, hotfix/, release/
is_gc_candidate_branch() {
  local branch="$1"
  case "${branch}" in
    feature/*|fix/*|refactor/*|hotfix/*|release/*) return 0 ;;
    *) return 1 ;;
  esac
}

# ── Days since last commit on a branch ───────────────────────────────────────
days_since_last_commit() {
  local branch="$1"
  local last_commit_ts
  last_commit_ts=$(git log -1 --format="%ct" "${branch}" 2>/dev/null || echo "0")
  if [ "${last_commit_ts}" = "0" ]; then
    echo "999"
    return
  fi
  local now
  now=$(date +%s)
  echo $(( (now - last_commit_ts) / 86400 ))
}

# ── Counters ──────────────────────────────────────────────────────────────────
FLAGGED_COUNT=0
DELETED_COUNT=0
SKIPPED_COUNT=0
PROTECTED_COUNT=0

# ── Header ────────────────────────────────────────────────────────────────────
info "Harness GC — $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
info "Retention: ${GC_DAYS} days | Dry run: ${DRY_RUN}"
info "Report: ${REPORT_FILE}"
info ""

# ── Main: iterate worktrees ───────────────────────────────────────────────────
# `git worktree list --porcelain` output format:
#   worktree /path/to/worktree
#   HEAD <sha>
#   branch refs/heads/<name>
#   (blank line)

process_worktrees() {
  local worktree_path=""
  local branch_ref=""

  while IFS= read -r line; do
    case "${line}" in
      "worktree "*)
        worktree_path="${line#worktree }"
        branch_ref=""
        ;;
      "branch refs/heads/"*)
        branch_ref="${line#branch refs/heads/}"
        ;;
      "")
        # End of a worktree block — process it
        if [ -n "${worktree_path}" ] && [ -n "${branch_ref}" ]; then
          process_one_worktree "${worktree_path}" "${branch_ref}"
        fi
        worktree_path=""
        branch_ref=""
        ;;
    esac
  done < <(git worktree list --porcelain && echo "")
}

process_one_worktree() {
  local wt_path="$1"
  local branch="$2"

  # Skip the main worktree (it is always the first entry, no branch ref needed)
  local main_worktree
  main_worktree=$(git worktree list --porcelain | grep '^worktree ' | head -1 | cut -d' ' -f2-)
  if [ "${wt_path}" = "${main_worktree}" ]; then
    return
  fi

  # Skip protected branches
  if is_protected "${branch}"; then
    info "SKIP (protected) branch=${branch} path=${wt_path}"
    PROTECTED_COUNT=$(( PROTECTED_COUNT + 1 ))
    return
  fi

  # Only process agent-created branches
  if ! is_gc_candidate_branch "${branch}"; then
    SKIPPED_COUNT=$(( SKIPPED_COUNT + 1 ))
    return
  fi

  local age_days
  age_days=$(days_since_last_commit "${branch}")
  local flag_file="${wt_path}/.gc-flagged"

  info "Checking branch=${branch} age=${age_days}d path=${wt_path}"

  if [ "${age_days}" -lt "${GC_DAYS}" ]; then
    # Fresh — remove flag if it was set (branch has new activity)
    if [ -f "${flag_file}" ]; then
      if [ "${DRY_RUN}" = "true" ]; then
        info "  DRY RUN: would remove stale flag (branch has new commits)"
      else
        rm -f "${flag_file}"
        ok "  Flag cleared (branch has new commits)"
      fi
    else
      info "  Fresh (${age_days}d < ${GC_DAYS}d) — no action"
    fi
    return
  fi

  # Stale branch
  if [ -f "${flag_file}" ]; then
    # Second run: flagged in a previous GC cycle → delete
    warn "  STALE + FLAGGED (${age_days}d) — deleting worktree and branch"
    if [ "${DRY_RUN}" = "true" ]; then
      warn "  DRY RUN: would run: git worktree remove --force \"${wt_path}\""
      warn "  DRY RUN: would run: git branch -d \"${branch}\""
    else
      git worktree remove --force "${wt_path}" 2>/dev/null || true
      git branch -d "${branch}" 2>/dev/null || git branch -D "${branch}" 2>/dev/null || true
      ok "  Deleted worktree and branch: ${branch}"
    fi
    DELETED_COUNT=$(( DELETED_COUNT + 1 ))
  else
    # First run: flag it for next cycle
    warn "  STALE (${age_days}d >= ${GC_DAYS}d) — flagging for next GC run"
    if [ "${DRY_RUN}" = "true" ]; then
      warn "  DRY RUN: would write ${flag_file}"
    else
      # The worktree directory must exist to write the flag
      if [ -d "${wt_path}" ]; then
        printf "Flagged by harness GC on %s. Will be deleted on next GC run unless new commits appear.\n" \
          "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "${flag_file}"
        ok "  Flagged: ${flag_file}"
      else
        warn "  Worktree path does not exist: ${wt_path} — skipping flag"
      fi
    fi
    FLAGGED_COUNT=$(( FLAGGED_COUNT + 1 ))
  fi
}

process_worktrees

# ── Summary ───────────────────────────────────────────────────────────────────
info ""
info "─── GC Summary ────────────────────────────────────────────"
info "  Flagged this run  : ${FLAGGED_COUNT}  (will be deleted on next GC run)"
info "  Deleted this run  : ${DELETED_COUNT}"
info "  Skipped (fresh)   : ${SKIPPED_COUNT}"
info "  Protected (kept)  : ${PROTECTED_COUNT}"
if [ "${DRY_RUN}" = "true" ]; then
  info "  Mode              : DRY RUN — no changes made"
fi
info "  Report            : ${REPORT_FILE}"
info "────────────────────────────────────────────────────────────"

ok "GC complete."
