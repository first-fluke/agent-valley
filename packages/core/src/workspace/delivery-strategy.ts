/**
 * Delivery strategy module — mergeAndPush (rebase-based), pushBranch,
 * createDraftPR. Handles rebase conflict auto-resolution with safety-net
 * classification shared from `safety-net.ts`.
 *
 * Internal module for `WorkspaceManager` (PR2 split).
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 5.4, § 6.7 (E27)
 */

import type { Workspace } from "../domain/models"
import { logger } from "../observability/logger"
import {
  buildLockfileRetryPrompt,
  classifyConflictFiles,
  findConflictMarkerFiles,
  isHighRiskConflictFile,
  isRegeneratableLockfile,
  type WorkspaceValidationResult,
} from "./safety-net"
import { repoRootOf, runCommand } from "./worktree-lifecycle"

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

/** Check that the feature branch has no unmerged or conflict-marker files before delivery. */
async function validateBranchBeforeMerge(root: string, branch: string): Promise<WorkspaceValidationResult> {
  const { stdout: unmergedOut } = await runCommand("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: root })
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

  const { stdout: branchOut } = await runCommand("git", ["diff", "--name-only", `main...${branch}`], { cwd: root })
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

  const checkResult = await runCommand("git", ["diff", "--check", `main...${branch}`], { cwd: root })
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

/**
 * Auto-resolve rebase conflicts.
 *
 * During rebase, "ours" = the branch being rebased onto (main),
 * "theirs" = the feature branch commits being replayed.
 * We accept "theirs" (feature branch) to preserve the agent's work — except
 * for lockfiles (retryable) and high-risk files (hard failure).
 */
async function autoResolveRebaseConflicts(root: string, branch: string): Promise<DeliveryResult> {
  const { stdout: conflictList } = await runCommand("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: root })
  const conflictedFiles = conflictList
    .trim()
    .split("\n")
    .filter((f) => f.length > 0)

  if (conflictedFiles.length === 0) return { ok: false, error: `Rebase conflict on ${branch}` }

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

  const highRiskFiles = conflictedFiles.filter((file) => isHighRiskConflictFile(file))
  if (highRiskFiles.length > 0 || lockfiles.length > 0) {
    const combined = [...new Set([...highRiskFiles, ...lockfiles])]
    logger.warn("workspace-manager", "Refusing to auto-resolve high-risk rebase conflicts", {
      branch,
      files: combined.join(", "),
    })
    return {
      ok: false,
      error: `Rebase conflict on ${branch}: ${combined.join(", ")}`,
    }
  }

  logger.info("workspace-manager", `Auto-resolving ${conflictedFiles.length} rebase conflict(s)`, {
    branch,
    files: conflictedFiles.join(", "),
  })

  // In rebase context: --theirs = the commit being rebased (feature branch)
  for (const file of conflictedFiles) {
    const { exitCode } = await runCommand("git", ["checkout", "--theirs", "--", file], { cwd: root })
    if (exitCode !== 0) {
      logger.warn("workspace-manager", `Failed to resolve ${file}`, { branch })
      return { ok: false, error: `Rebase conflict on ${branch}: failed to resolve ${file}` }
    }
    await runCommand("git", ["add", file], { cwd: root })
  }

  const { exitCode: continueExit } = await runCommand("git", ["rebase", "--continue"], {
    cwd: root,
    env: { ...process.env, GIT_EDITOR: "true" },
  })

  if (continueExit !== 0) {
    const { exitCode: moreConflicts } = await runCommand("git", ["diff", "--check"], { cwd: root })
    if (moreConflicts !== 0) {
      return autoResolveRebaseConflicts(root, branch)
    }
  }

  logger.info("workspace-manager", `Auto-resolved rebase conflicts for ${branch}`)
  return { ok: true }
}

/** Rebase the feature branch onto main, fast-forward merge, and push. Retries up to 3 times on push rejection. */
export async function mergeAndPush(workspace: Workspace, rootFallback: string): Promise<DeliveryResult> {
  const root = repoRootOf(workspace, rootFallback)
  const branch = workspace.branch
  const maxAttempts = 3

  const hasRemote = (await runCommand("git", ["remote", "get-url", "origin"], { cwd: root })).exitCode === 0

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 1. Update main to latest
    if (hasRemote) {
      await runCommand("git", ["checkout", "main"], { cwd: root })
      await runCommand("git", ["pull", "--ff-only", "origin", "main"], { cwd: root })
    }

    // 2. Check if branch has any commits ahead of main
    const { exitCode: diffExit } = await runCommand("git", ["diff", "--quiet", `main...${branch}`], { cwd: root })
    if (diffExit === 0) {
      logger.info("workspace-manager", "No changes to merge", { branch })
      return { ok: true }
    }

    const preRebaseValidation = await validateBranchBeforeMerge(root, branch)
    if (!preRebaseValidation.ok) {
      logger.error("workspace-manager", "Branch validation failed before merge delivery", {
        branch,
        error: preRebaseValidation.error,
      })
      return { ok: false, error: preRebaseValidation.error }
    }

    // 3. Rebase feature branch onto latest main.
    //    This puts agent's work on top of all other agents' merged work.
    //    If conflict: agent's code adapts to main, not the other way around.
    const { exitCode: rebaseExit, stderr: rebaseErr } = await runCommand("git", ["rebase", "main", branch], {
      cwd: root,
    })

    if (rebaseExit !== 0) {
      // rerere might resolve it
      const { exitCode: conflictCheck } = await runCommand("git", ["diff", "--check"], { cwd: root })
      if (conflictCheck !== 0) {
        const resolved = await autoResolveRebaseConflicts(root, branch)
        if (!resolved.ok) {
          await runCommand("git", ["rebase", "--abort"], { cwd: root })
          logger.error("workspace-manager", "Rebase failed with unresolved conflicts", {
            branch,
            error: resolved.error ?? rebaseErr,
            retryable: resolved.retryable ?? false,
          })
          return {
            ok: false,
            error: resolved.error ?? `Rebase conflict on ${branch}: ${rebaseErr}`,
            retryable: resolved.retryable,
            retryPrompt: resolved.retryPrompt,
          }
        }
      } else {
        // rerere resolved — continue rebase
        await runCommand("git", ["add", "."], { cwd: root })
        await runCommand("git", ["rebase", "--continue"], { cwd: root, env: { ...process.env, GIT_EDITOR: "true" } })
      }
    }

    const postRebaseValidation = await validateBranchBeforeMerge(root, branch)
    if (!postRebaseValidation.ok) {
      logger.error("workspace-manager", "Branch validation failed after rebase", {
        branch,
        error: postRebaseValidation.error,
      })
      return { ok: false, error: postRebaseValidation.error }
    }

    // 4. Fast-forward merge into main (guaranteed clean after rebase)
    await runCommand("git", ["checkout", "main"], { cwd: root })
    const { exitCode: mergeExit } = await runCommand("git", ["merge", "--ff-only", branch], { cwd: root })
    if (mergeExit !== 0) {
      logger.warn("workspace-manager", "ff-only merge failed, falling back to regular merge", { branch })
      await runCommand("git", ["merge", branch, "--no-edit"], { cwd: root })
    }

    // 5. Push main
    if (hasRemote) {
      const { exitCode: pushExit, stderr: pushErr } = await runCommand("git", ["push", "origin", "main"], {
        cwd: root,
      })
      if (pushExit !== 0) {
        if (attempt < maxAttempts) {
          logger.warn("workspace-manager", `Push rejected, retrying (${attempt}/${maxAttempts})`, { branch })
          await runCommand("git", ["reset", "--hard", "origin/main"], { cwd: root })
          continue
        }
        logger.error("workspace-manager", "Push failed after retries", { error: pushErr })
        return { ok: false, error: `Push failed: ${pushErr}` }
      }
    }

    // 6. Delete the feature branch
    await runCommand("git", ["branch", "-D", branch], { cwd: root })

    logger.info("workspace-manager", "Merged and pushed", { branch })
    return { ok: true }
  }

  return { ok: false, error: `Merge+push failed after ${maxAttempts} attempts` }
}

/** Push the feature branch to origin. Returns ok:true silently when no remote is configured. */
export async function pushBranch(workspace: Workspace, rootFallback: string): Promise<PushResult> {
  const root = repoRootOf(workspace, rootFallback)
  const branch = workspace.branch

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
