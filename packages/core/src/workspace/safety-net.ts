/**
 * Safety-net module — conflict classification and auto-commit of unfinished
 * agent work before cleanup or retry. Shared with delivery-strategy for
 * rebase-conflict classification (lockfile vs high-risk vs generic).
 *
 * Internal module for `WorkspaceManager` (PR2 split).
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 5.4, § 6.7 (E27, E28)
 */

import { readFile } from "node:fs/promises"
import type { Workspace } from "../domain/models"
import { logger } from "../observability/logger"
import { runCommand } from "./worktree-lifecycle"

export interface WorkspaceValidationResult {
  ok: boolean
  error?: string
  retryable?: boolean
  retryPrompt?: string
}

export const CONFLICT_MARKER_PATTERN = /^(<<<<<<<|=======|>>>>>>>)( .*)?$/m

export const REGENERATABLE_LOCKFILE_PATTERNS: readonly RegExp[] = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)bun\.lockb?$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)uv\.lock$/,
  /(^|\/)go\.sum$/,
]

export const HIGH_RISK_CONFLICT_PATTERNS: readonly RegExp[] = [
  /(^|\/)package\.json$/,
  /(^|\/)pyproject\.toml$/,
  /(^|\/)go\.mod$/,
  /(^|\/)(middleware|auth|auth-client|auth-server|env|config)\.[^/]+$/,
  /(^|\/)auth\//,
]

export function isRegeneratableLockfile(file: string): boolean {
  return REGENERATABLE_LOCKFILE_PATTERNS.some((pattern) => pattern.test(file))
}

export function isHighRiskConflictFile(file: string): boolean {
  return HIGH_RISK_CONFLICT_PATTERNS.some((pattern) => pattern.test(file))
}

export function buildLockfileRetryPrompt(files: string[]): string {
  return [
    `Lockfile conflicts require regeneration in: ${files.join(", ")}`,
    "Retry instruction:",
    "- Sync your branch with the latest main changes before resolving the dependency graph.",
    "- Run the repo's dependency install or sync command to regenerate the conflicted lockfile(s).",
    "- Review the regenerated lockfile diff and keep only intentional dependency updates.",
  ].join("\n")
}

/** Parse `-z`-delimited `git status --porcelain` or `git diff --name-only -z` output. */
export function parseNullSeparatedPaths(output: string): string[] {
  const entries = output.split("\0").filter((entry) => entry.length > 0)
  const files: string[] = []

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? ""
    if (entry.length < 4) continue

    const status = entry.slice(0, 2)
    let path = entry.slice(3)

    if (status.includes("R") || status.includes("C")) {
      i++
      path = entries[i] ?? path
    }

    if (path.length > 0) files.push(path)
  }

  return files
}

export interface ConflictClassificationLabels {
  retryablePrefix: string
  retryableFix: string
  manualPrefix: string
  manualFix: string
}

export function classifyConflictFiles(
  files: string[],
  labels: ConflictClassificationLabels,
): WorkspaceValidationResult {
  const lockfiles = files.filter((file) => isRegeneratableLockfile(file))
  if (lockfiles.length === files.length) {
    return {
      ok: false,
      retryable: true,
      error: `${labels.retryablePrefix}: ${lockfiles.join(", ")}\n  Fix: ${labels.retryableFix}`,
      retryPrompt: buildLockfileRetryPrompt(lockfiles),
    }
  }

  return {
    ok: false,
    error: `${labels.manualPrefix}: ${files.join(", ")}\n  Fix: ${labels.manualFix}`,
  }
}

/** Scan `files` (relative to `root`) for any file containing a git conflict marker. */
export async function findConflictMarkerFiles(root: string, files: string[]): Promise<string[]> {
  const conflicts: string[] = []

  for (const file of files) {
    try {
      const content = await readFile(`${root}/${file}`, "utf-8")
      if (CONFLICT_MARKER_PATTERN.test(content)) {
        conflicts.push(file)
      }
    } catch {
      // Deleted, binary, or unreadable files are skipped.
    }
  }

  return conflicts
}

/**
 * Inspect a worktree for unmerged files or conflict markers before running
 * auto-commit. Returns ok=true when the worktree is safe to commit.
 */
export async function validateWorktreeBeforeAutoCommit(cwd: string): Promise<WorkspaceValidationResult> {
  const { stdout: unmergedOut } = await runCommand("git", ["diff", "--name-only", "--diff-filter=U"], { cwd })
  const unmergedFiles = unmergedOut
    .trim()
    .split("\n")
    .filter((file) => file.length > 0)
  if (unmergedFiles.length > 0) {
    return {
      ok: false,
      error: `Unmerged files present: ${unmergedFiles.join(", ")}\n  Fix: Resolve the merge conflicts manually before auto-commit.`,
    }
  }

  const { stdout: statusOut } = await runCommand("git", ["status", "--porcelain", "--untracked-files=all", "-z"], {
    cwd,
  })
  const changedFiles = parseNullSeparatedPaths(statusOut).filter((file) => !file.startsWith(".agent-valley/"))
  const conflictMarkerFiles = await findConflictMarkerFiles(cwd, changedFiles)
  if (conflictMarkerFiles.length > 0) {
    return classifyConflictFiles(conflictMarkerFiles, {
      retryablePrefix: "Conflict markers detected in regeneratable lockfiles",
      retryableFix: "Regenerate the lockfile before auto-commit.",
      manualPrefix: "Conflict markers detected in changed files",
      manualFix: "Resolve the conflict markers before auto-commit.",
    })
  }

  await runCommand("git", ["add", "-A", "--", ".", ":!.agent-valley"], { cwd })

  const { stdout: stagedOut } = await runCommand("git", ["diff", "--cached", "--name-only", "-z"], { cwd })
  const stagedFiles = parseNullSeparatedPaths(stagedOut).filter((file) => !file.startsWith(".agent-valley/"))
  const stagedConflictFiles = await findConflictMarkerFiles(cwd, stagedFiles)
  if (stagedConflictFiles.length > 0) {
    await runCommand("git", ["reset"], { cwd })
    return classifyConflictFiles(stagedConflictFiles, {
      retryablePrefix: "Conflict markers detected in staged regeneratable lockfiles",
      retryableFix: "Regenerate the lockfile before auto-commit.",
      manualPrefix: "Conflict markers detected in staged files",
      manualFix: "Resolve the conflict markers before auto-commit.",
    })
  }

  const checkResult = await runCommand("git", ["diff", "--cached", "--check"], { cwd })
  if (checkResult.exitCode !== 0) {
    await runCommand("git", ["reset"], { cwd })
    const details = (checkResult.stdout || checkResult.stderr).trim()
    return {
      ok: false,
      error:
        `git diff --cached --check failed.\n${details}\n` +
        "  Fix: Resolve the reported diff problems before auto-commit.",
    }
  }

  return { ok: true }
}

/** Run the full validation + safety-net auto-commit on the workspace. */
export async function autoCommit(workspace: Workspace): Promise<WorkspaceValidationResult> {
  const cwd = workspace.path

  const validation = await validateWorktreeBeforeAutoCommit(cwd)
  if (!validation.ok) {
    logger.warn("workspace-manager", "Auto-commit blocked by workspace validation", {
      workspacePath: workspace.path,
      error: validation.error,
      retryable: validation.retryable ?? false,
    })
    return {
      ok: false,
      error: validation.error,
      retryable: validation.retryable,
      retryPrompt: validation.retryPrompt,
    }
  }

  const { exitCode } = await runCommand("git", ["commit", "-m", "chore: auto-commit unfinished agent work"], { cwd })

  if (exitCode !== 0) {
    logger.warn("workspace-manager", "Auto-commit failed", { workspacePath: workspace.path })
    return {
      ok: false,
      error: "git commit failed.\n  Fix: Inspect the worktree and resolve the remaining git issues.",
    }
  }

  logger.info("workspace-manager", "Auto-committed unfinished work", { workspacePath: workspace.path })
  return { ok: true }
}
