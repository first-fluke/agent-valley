/**
 * Delivery strategy module — mergeAndPush (rebase-based), pushBranch,
 * createDraftPR. Handles rebase conflict auto-resolution with safety-net
 * classification shared from `safety-net.ts`.
 *
 * Internal module for `WorkspaceManager` (PR2 split).
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 5.4, § 6.7 (E27)
 */

import { randomUUID } from "node:crypto"
import { lstatSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Workspace } from "../domain/models"
import { logger } from "../observability/logger"
import {
  buildLockfileRetryPrompt,
  buildRebaseConflictRetryPrompt,
  classifyConflictFiles,
  findConflictMarkerFiles,
  isHighRiskConflictFile,
  isRegeneratableLockfile,
  type WorkspaceValidationResult,
} from "./safety-net"
import { isIsolatedGitWorkspace, repoRootOf, runCommand } from "./worktree-lifecycle"

export interface DeliveryResult {
  ok: boolean
  error?: string
  retryable?: boolean
  retryPrompt?: string
}

export interface PushResult {
  ok: boolean
  error?: string
}

export interface DraftPrResult {
  created: boolean
  url?: string
}

/** Bring a Linux clone's issue branch into the source repository for delivery. */
async function importIsolatedBranch(workspace: Workspace, root: string): Promise<string | null> {
  if (!isIsolatedGitWorkspace(workspace)) return null
  const ref = `refs/heads/${workspace.branch}`
  const importedRef = `refs/agent-valley/imports/${randomUUID().replaceAll("-", "")}`
  // Fetch into a private ref first. Directly fetching cloneRef:sourceRef can
  // reject after the source branch was rebased, before retry objects arrive.
  const fetched = await runCommand("git", ["fetch", "--no-tags", workspace.path, `${ref}:${importedRef}`], {
    cwd: root,
  })
  if (fetched.exitCode !== 0) {
    return `Could not import ${workspace.branch} from isolated workspace: ${fetched.stderr.trim()}\n  Fix: Restore the issue branch before delivery.`
  }

  let temporaryWorktree: string | null = null
  let worktreeAdded = false
  try {
    const imported = await runCommand("git", ["rev-parse", "--verify", importedRef], { cwd: root })
    if (imported.exitCode !== 0) return `Could not read imported branch ${workspace.branch}.`
    const cloneHead = imported.stdout.trim()
    const current = await runCommand("git", ["rev-parse", "--verify", ref], { cwd: root })
    const currentHead = current.exitCode === 0 ? current.stdout.trim() : null
    if (!currentHead) {
      const created = await runCommand("git", ["update-ref", ref, cloneHead, "0".repeat(40)], { cwd: root })
      return created.exitCode === 0
        ? null
        : `Could not create source branch ${workspace.branch}: ${created.stderr.trim()}`
    }
    if (currentHead === cloneHead) return null
    if (
      (await runCommand("git", ["merge-base", "--is-ancestor", cloneHead, currentHead], { cwd: root })).exitCode === 0
    ) {
      return null
    }
    if (
      (await runCommand("git", ["merge-base", "--is-ancestor", currentHead, cloneHead], { cwd: root })).exitCode === 0
    ) {
      const updated = await runCommand("git", ["update-ref", ref, cloneHead, currentHead], { cwd: root })
      return updated.exitCode === 0 ? null : `Source branch ${workspace.branch} changed during import; retry delivery.`
    }

    const range = `${currentHead}...${cloneHead}`
    const merges = await runCommand("git", ["rev-list", "--right-only", "--merges", range], { cwd: root })
    if (merges.exitCode !== 0 || merges.stdout.trim()) {
      return `Retry branch ${workspace.branch} contains merge commits. Resolve the diverged branch manually before delivery.`
    }
    const replay = await runCommand(
      "git",
      ["rev-list", "--reverse", "--right-only", "--cherry-pick", "--no-merges", range],
      { cwd: root },
    )
    if (replay.exitCode !== 0) return `Could not compare retry commits for ${workspace.branch}: ${replay.stderr.trim()}`
    const commits = replay.stdout.trim().split("\n").filter(Boolean)
    if (commits.length === 0) return null

    temporaryWorktree = await mkdtemp(join(tmpdir(), "av-branch-import-"))
    const added = await runCommand("git", ["worktree", "add", "--detach", temporaryWorktree, currentHead], {
      cwd: root,
    })
    if (added.exitCode !== 0) return `Could not prepare retry import for ${workspace.branch}: ${added.stderr.trim()}`
    worktreeAdded = true
    for (const commit of commits) {
      const identity = await runCommand("git", ["show", "-s", "--format=%cn%x00%ce", commit], { cwd: root })
      const [name, email] = identity.stdout.trim().split("\0")
      if (identity.exitCode !== 0 || !name || !email)
        return `Could not read retry commit identity for ${workspace.branch}.`
      const picked = await runCommand("git", ["cherry-pick", commit], {
        cwd: temporaryWorktree,
        env: { GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email },
      })
      if (picked.exitCode !== 0) {
        await runCommand("git", ["cherry-pick", "--abort"], { cwd: temporaryWorktree })
        return `Retry commit for ${workspace.branch} conflicts with the rebased branch: ${picked.stderr.trim()}\n  Fix: Reapply the change on the current branch before delivery.`
      }
    }
    const replayed = await runCommand("git", ["rev-parse", "HEAD"], { cwd: temporaryWorktree })
    if (replayed.exitCode !== 0) return `Could not read replayed retry branch ${workspace.branch}.`
    const updated = await runCommand("git", ["update-ref", ref, replayed.stdout.trim(), currentHead], { cwd: root })
    return updated.exitCode === 0
      ? null
      : `Source branch ${workspace.branch} changed during retry import; retry delivery.`
  } finally {
    if (temporaryWorktree) {
      if (worktreeAdded) await runCommand("git", ["worktree", "remove", "--force", temporaryWorktree], { cwd: root })
      await rm(temporaryWorktree, { recursive: true, force: true })
    }
    await runCommand("git", ["update-ref", "-d", importedRef], { cwd: root })
  }
}

/** Check that the feature branch has no unmerged or conflict-marker files before delivery. */
async function validateBranchBeforeMerge(
  root: string,
  base: string,
  branch: string,
): Promise<WorkspaceValidationResult> {
  const unmerged = await runCommand("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: root })
  if (unmerged.exitCode !== 0) {
    return { ok: false, error: `Could not inspect unmerged files: ${unmerged.stderr.trim()}` }
  }
  const unmergedOut = unmerged.stdout
  const unmergedFiles = unmergedOut
    .trim()
    .split("\n")
    .filter((file) => file.length > 0)
  if (unmergedFiles.length > 0) {
    return {
      ok: false,
      error: `Unmerged files present: ${unmergedFiles.join(", ")}\n  Fix: Resolve the merge conflicts manually before delivery.`,
    }
  }

  const changed = await runCommand("git", ["diff", "--name-only", `${base}...${branch}`], { cwd: root })
  if (changed.exitCode !== 0) {
    return { ok: false, error: `Could not inspect ${branch} against ${base}: ${changed.stderr.trim()}` }
  }
  const branchOut = changed.stdout
  const changedFiles = branchOut
    .trim()
    .split("\n")
    .filter((file) => file.length > 0)
  const conflictMarkerFiles = await findConflictMarkerFiles(root, changedFiles)
  if (conflictMarkerFiles.length > 0) {
    return classifyConflictFiles(conflictMarkerFiles, {
      retryablePrefix: "Conflict markers detected in delivery lockfiles",
      retryableFix: "Regenerate the lockfile before delivery.",
      manualPrefix: "Conflict markers detected in branch files",
      manualFix: "Resolve the conflict markers manually before delivery.",
    })
  }

  const checkResult = await runCommand("git", ["diff", "--check", `${base}...${branch}`], { cwd: root })
  if (checkResult.exitCode !== 0) {
    const details = (checkResult.stdout || checkResult.stderr).trim()
    return {
      ok: false,
      error:
        `git diff --check failed for ${branch}.\n${details}\n` +
        "  Fix: Resolve the reported diff problems before delivery.",
    }
  }

  return { ok: true }
}

function gitFailure(action: string, result: { stderr: string; stdout: string }, fix: string): DeliveryResult {
  return {
    ok: false,
    error: `${action} failed: ${(result.stderr || result.stdout).trim() || "Git returned an error."}\n  Fix: ${fix}`,
  }
}

/** A linked issue branch is checked out in its own worktree and must be rebased there. */
function linkedWorktreePath(workspace: Workspace): string | null {
  try {
    return lstatSync(`${workspace.path}/.git`).isFile() ? workspace.path : null
  } catch {
    return null
  }
}

/** Resolve a stable delivery target without treating an arbitrary checkout as the base. */
async function resolveDeliveryBase(
  root: string,
  issueBranch: string,
  hasRemote: boolean,
): Promise<{ base: string; currentBranch: string } | null> {
  const localHead = await runCommand("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root })
  const currentBranch = localHead.exitCode === 0 ? localHead.stdout.trim() : ""
  let base = ""
  // Operators can pin the target in this repository's .git/config with:
  // git config --local agent-valley.baseBranch trunk
  const configured = await runCommand("git", ["config", "--local", "--get", "agent-valley.baseBranch"], {
    cwd: root,
  })
  if (configured.exitCode === 0 && configured.stdout.trim()) {
    base = configured.stdout.trim()
  } else if (hasRemote) {
    const remoteHead = await runCommand("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
      cwd: root,
    })
    if (remoteHead.exitCode === 0 && remoteHead.stdout.trim().startsWith("origin/")) {
      base = remoteHead.stdout.trim().slice("origin/".length)
    }
  }
  if (!base && hasRemote) {
    // A single tracked remote branch can identify the target when origin/HEAD
    // is absent. The current checkout is never evidence by itself.
    const tracked = await runCommand("git", ["for-each-ref", "--format=%(refname:strip=3)", "refs/remotes/origin"], {
      cwd: root,
    })
    if (tracked.exitCode === 0) {
      const candidates = tracked.stdout
        .trim()
        .split("\n")
        .filter((name) => name && name !== "HEAD" && name !== issueBranch)
      if (candidates.length === 1) base = candidates[0] as string
    }
  }
  if (!base) {
    // A repository with only one non-issue local branch has a single possible
    // target. Multiple candidates require an explicit repo-local setting.
    const local = await runCommand("git", ["for-each-ref", "--format=%(refname:strip=2)", "refs/heads"], {
      cwd: root,
    })
    if (local.exitCode === 0) {
      const candidates = local.stdout
        .trim()
        .split("\n")
        .filter((name) => name && name !== issueBranch)
      if (candidates.length === 1) base = candidates[0] as string
    }
  }
  if (!base || base === issueBranch) return null
  const exists = await runCommand("git", ["show-ref", "--verify", "--quiet", `refs/heads/${base}`], { cwd: root })
  return exists.exitCode === 0 ? { base, currentBranch } : null
}

/**
 * Classify a rebase conflict. This function never mutates the working tree —
 * it only inspects the conflicted file list and decides a retry strategy.
 * The caller (`mergeAndPush`) always aborts the rebase after a non-ok result.
 *
 * We used to resolve ordinary conflicts by running `git checkout --theirs`
 * per file. In a rebase, "theirs" is the feature-branch commit being
 * replayed, but `--theirs` replaces the file with that commit's ENTIRE
 * blob — it is not a hunk-by-hunk merge. Any change main had already
 * contributed to that file (including hunks that would have merged
 * cleanly) was silently discarded. That caused real, silent work loss
 * when two agents touched the same file: whichever rebased second would
 * wipe out the first agent's already-merged change. We never do that now.
 *
 * Contract:
 * - Any conflicted file matching `HIGH_RISK_CONFLICT_PATTERNS` (dependency
 *   manifests, auth, migrations, schema, ...) → hard failure, not
 *   retryable. These are never safe to resolve mechanically or reattempt
 *   without human review.
 * - Conflict confined entirely to regeneratable lockfiles → retryable; the
 *   agent regenerates the lockfile against the new main.
 * - Any other conflict (ordinary source files, or a mix of lockfiles and
 *   ordinary files) → retryable; the agent re-applies its change on top of
 *   current main, preserving both sides. No file is overwritten here.
 */
async function autoResolveRebaseConflicts(root: string, branch: string): Promise<DeliveryResult> {
  const { stdout: conflictList } = await runCommand("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: root })
  const conflictedFiles = conflictList
    .trim()
    .split("\n")
    .filter((f) => f.length > 0)

  if (conflictedFiles.length === 0) return { ok: false, error: `Rebase conflict on ${branch}` }

  const highRiskFiles = conflictedFiles.filter((file) => isHighRiskConflictFile(file))
  if (highRiskFiles.length > 0) {
    logger.warn("workspace-manager", "Refusing to auto-resolve high-risk rebase conflicts", {
      branch,
      files: highRiskFiles.join(", "),
    })
    return {
      ok: false,
      error:
        `Rebase conflict on ${branch} touches high-risk file(s): ${highRiskFiles.join(", ")}\n` +
        "  Fix: Resolve these conflicts manually — high-risk files (dependency manifests, auth, " +
        "migrations, schema) are never auto-resolved or auto-retried.",
    }
  }

  const lockfiles = conflictedFiles.filter((file) => isRegeneratableLockfile(file))
  if (lockfiles.length === conflictedFiles.length) {
    logger.warn("workspace-manager", "Deferring lockfile rebase conflicts to agent retry", {
      branch,
      files: lockfiles.join(", "),
    })
    return {
      ok: false,
      retryable: true,
      error: `Rebase conflicted in regeneratable lockfiles: ${lockfiles.join(", ")}`,
      retryPrompt: buildLockfileRetryPrompt(lockfiles),
    }
  }

  logger.warn("workspace-manager", "Deferring rebase conflict to agent retry (no destructive auto-resolution)", {
    branch,
    files: conflictedFiles.join(", "),
  })
  return {
    ok: false,
    retryable: true,
    error: `Rebase conflicted on ${branch} in: ${conflictedFiles.join(", ")}`,
    retryPrompt: buildRebaseConflictRetryPrompt(conflictedFiles),
  }
}

/**
 * Rebase the issue branch onto the repository base, merge, then push when an
 * origin exists. A rejected push leaves local commits intact for a safe retry.
 *
 * `opts.verified` is NOT the enforcement point for the verification gate.
 * The only current caller (`completion-handler.ts`) never passes `opts` at
 * all — it enforces the gate itself by simply not calling `mergeAndPush`
 * when the verification gate (`verify_command`) failed. The
 * `opts.verified === false` check below is unreachable in production today;
 * it exists solely as cheap defense-in-depth for a future direct caller
 * that explicitly passes `verified: false`. Do not rely on it as the
 * verification gate — that logic lives entirely in `completion-handler.ts`.
 */
export async function mergeAndPush(
  workspace: Workspace,
  rootFallback: string,
  opts: { verified?: boolean } = {},
): Promise<DeliveryResult> {
  if (opts.verified === false) {
    logger.error("workspace-manager", "mergeAndPush refused — verification gate did not pass", {
      branch: workspace.branch,
    })
    return {
      ok: false,
      error:
        "mergeAndPush called with verified:false.\n" +
        "  Fix: Do not call mergeAndPush until the verification gate (verify_command) reports ok:true.",
    }
  }

  const root = repoRootOf(workspace, rootFallback)
  const branch = workspace.branch

  const hasRemote = (await runCommand("git", ["remote", "get-url", "origin"], { cwd: root })).exitCode === 0
  const resolution = await resolveDeliveryBase(root, branch, hasRemote)
  if (!resolution) {
    return {
      ok: false,
      error: `Could not identify the repository base branch for ${branch}.\n  Fix: Set origin/HEAD or run git config --local agent-valley.baseBranch <base-branch> in the source repository, then retry delivery.`,
    }
  }
  const { base, currentBranch } = resolution

  const importError = await importIsolatedBranch(workspace, root)
  if (importError) return { ok: false, error: importError }

  if (hasRemote || currentBranch !== base) {
    const checkout = await runCommand("git", ["checkout", base], { cwd: root })
    if (checkout.exitCode !== 0)
      return gitFailure(
        `Checkout of ${base}`,
        checkout,
        "Preserve local changes, then check out the base branch and retry.",
      )
  }

  if (hasRemote) {
    const pull = await runCommand("git", ["pull", "--ff-only", "origin", base], { cwd: root })
    if (pull.exitCode !== 0)
      return gitFailure(`Update of ${base}`, pull, "Reconcile the local and remote base branches before retrying.")
  }

  const diff = await runCommand("git", ["diff", "--quiet", `${base}...${branch}`], { cwd: root })
  if (diff.exitCode !== 0 && diff.exitCode !== 1)
    return gitFailure(`Diff of ${branch} against ${base}`, diff, "Restore the issue and base branches before retrying.")

  const integrated = await runCommand("git", ["merge-base", "--is-ancestor", branch, base], { cwd: root })
  if (integrated.exitCode > 1 || integrated.exitCode < 0)
    return gitFailure(`Integration check for ${branch}`, integrated, "Restore the issue branch before retrying.")

  if (integrated.exitCode !== 0) {
    const preRebaseValidation = await validateBranchBeforeMerge(root, base, branch)
    if (!preRebaseValidation.ok) return { ok: false, error: preRebaseValidation.error }

    const linkedPath = linkedWorktreePath(workspace)
    const rebaseCwd = linkedPath ?? root
    if (linkedPath) {
      const checkedOut = await runCommand("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: linkedPath })
      if (checkedOut.exitCode !== 0 || checkedOut.stdout.trim() !== branch)
        return {
          ok: false,
          error: `Issue worktree is not on ${branch}.\n  Fix: Restore its issue branch before retrying delivery.`,
        }
    }
    const rebase = await runCommand("git", linkedPath ? ["rebase", base] : ["rebase", base, branch], {
      cwd: rebaseCwd,
    })
    if (rebase.exitCode !== 0) {
      await runCommand("git", ["diff", "--check"], { cwd: rebaseCwd })
      const conflict = await autoResolveRebaseConflicts(rebaseCwd, branch)
      const abort = await runCommand("git", ["rebase", "--abort"], { cwd: rebaseCwd })
      if (abort.exitCode !== 0)
        return gitFailure(
          `Abort of failed rebase for ${branch}`,
          abort,
          "Resolve the repository rebase state manually.",
        )
      return {
        ok: false,
        error: conflict.error ?? `Rebase of ${branch} onto ${base} failed: ${rebase.stderr.trim()}`,
        retryable: conflict.retryable,
        retryPrompt: conflict.retryPrompt,
      }
    }

    const postRebaseValidation = await validateBranchBeforeMerge(root, base, branch)
    if (!postRebaseValidation.ok) return { ok: false, error: postRebaseValidation.error }

    const backToBase = await runCommand("git", ["checkout", base], { cwd: root })
    if (backToBase.exitCode !== 0)
      return gitFailure(
        `Checkout of ${base} after rebase`,
        backToBase,
        "Preserve the rebased branch and repair the checkout before retrying.",
      )

    const fastForward = await runCommand("git", ["merge", "--ff-only", branch], { cwd: root })
    if (fastForward.exitCode !== 0) {
      const merged = await runCommand("git", ["merge", branch, "--no-edit"], { cwd: root })
      if (merged.exitCode !== 0) {
        const abort = await runCommand("git", ["merge", "--abort"], { cwd: root })
        const fix =
          abort.exitCode === 0
            ? "Resolve the base/issue conflict before retrying; both branches remain available."
            : "Resolve the repository merge state manually; both branches remain available."
        return gitFailure(`Merge of ${branch} into ${base}`, merged, fix)
      }
    }

    const verified = await runCommand("git", ["merge-base", "--is-ancestor", branch, base], { cwd: root })
    if (verified.exitCode !== 0)
      return gitFailure(
        `Final integration check for ${branch}`,
        verified,
        "Inspect both branches before retrying delivery.",
      )
  }

  if (hasRemote) {
    const pushed = await runCommand("git", ["push", "origin", base], { cwd: root })
    if (pushed.exitCode !== 0)
      return gitFailure(
        `Push of ${base}`,
        pushed,
        "Keep the local commits and reconcile the remote branch before retrying; no reset was run.",
      )
  }

  const cleanup = await runCommand("git", ["branch", "-d", branch], { cwd: root })
  if (cleanup.exitCode !== 0) {
    logger.warn("workspace-manager", "Delivery succeeded but issue branch cleanup was skipped", {
      branch,
      base,
      error: cleanup.stderr.trim(),
    })
  }
  logger.info("workspace-manager", "Delivered branch", { branch, base, pushed: hasRemote })
  return { ok: true }
}

/** Push the feature branch to origin. Returns ok:true silently when no remote is configured. */
export async function pushBranch(workspace: Workspace, rootFallback: string): Promise<PushResult> {
  const root = repoRootOf(workspace, rootFallback)
  const branch = workspace.branch

  const importError = await importIsolatedBranch(workspace, root)
  if (importError) return { ok: false, error: importError }

  const hasRemote = (await runCommand("git", ["remote", "get-url", "origin"], { cwd: root })).exitCode === 0
  if (!hasRemote) return { ok: true }

  const { exitCode, stderr } = await runCommand("git", ["push", "-u", "origin", branch], { cwd: root })
  if (exitCode !== 0) {
    logger.error("workspace-manager", "Branch push failed", { branch, error: stderr })
    return { ok: false, error: `Push failed: ${stderr}` }
  }

  logger.info("workspace-manager", "Pushed branch", { branch })
  return { ok: true }
}

/** Create a draft PR via the `gh` CLI if one does not already exist for the branch. Best effort. */
export async function createDraftPR(
  workspace: Workspace,
  rootFallback: string,
  opts: { title: string; body: string },
): Promise<DraftPrResult> {
  const root = repoRootOf(workspace, rootFallback)
  const branch = workspace.branch

  const importError = await importIsolatedBranch(workspace, root)
  if (importError) {
    logger.warn("workspace-manager", "Draft PR branch import failed", { branch, error: importError })
    return { created: false }
  }

  const { stdout: existing } = await runCommand(
    "gh",
    ["pr", "list", "--head", branch, "--json", "url", "--limit", "1"],
    { cwd: root },
  )
  try {
    const prs = JSON.parse(existing.trim() || "[]") as Array<{ url: string }>
    if (prs.length > 0) return { created: false, url: prs[0]?.url }
  } catch {
    // parse error — continue to create
  }

  const { exitCode, stdout, stderr } = await runCommand(
    "gh",
    ["pr", "create", "--draft", "--title", opts.title, "--body", opts.body, "--head", branch],
    { cwd: root },
  )

  if (exitCode !== 0) {
    logger.warn("workspace-manager", "Draft PR creation failed", { branch, error: stderr })
    return { created: false }
  }

  const url = stdout.trim()
  return { created: true, url }
}
