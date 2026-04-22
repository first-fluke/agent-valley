/**
 * Worktree lifecycle helpers — pure functions for workspace creation,
 * lookup, metadata persistence, cleanup, and diff detection.
 *
 * Internal module for `WorkspaceManager` (PR2 split). Not exported from
 * the package root; callers use `WorkspaceManager` or `WorkspaceGateway`.
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 5.4
 */

import { spawn } from "node:child_process"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import type { Issue, RunAttempt, Workspace } from "../domain/models"
import { logger } from "../observability/logger"

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface RunCommandOptions {
  cwd?: string
  ignoreStdio?: boolean
  env?: Record<string, string | undefined>
}

/** Run a command and return its exit code, stdout, and stderr. */
export function runCommand(cmd: string, args: string[], options: RunCommandOptions = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd: options.cwd ?? process.cwd(),
      stdio: options.ignoreStdio ? "ignore" : ["ignore", "pipe", "pipe"],
      env: options.env ? { ...process.env, ...options.env } : undefined,
    })

    let stdout = ""
    let stderr = ""
    if (!options.ignoreStdio) {
      if (proc.stdout) {
        proc.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString()
        })
      }
      if (proc.stderr) {
        proc.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString()
        })
      }
    }

    proc.once("close", (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr })
    })
  })
}

/** Map conventional commit prefixes to git branch prefixes. */
const BRANCH_PREFIX_MAP: Record<string, string> = {
  feat: "feature",
  fix: "fix",
  hotfix: "hotfix",
  refactor: "refactor",
  release: "release",
}

/**
 * Derive a git branch name from issue identifier + title.
 * Falls back to "feature" when no recognized prefix is present.
 */
export function deriveBranchName(identifier: string, title: string): string {
  const match = title.match(/^(\w+)[\s(:]/)
  const prefix = match ? (BRANCH_PREFIX_MAP[match[1] ?? ""] ?? "feature") : "feature"
  return `${prefix}/${identifier}`
}

/** Sanitize an issue identifier for use as a directory key. */
export function deriveKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_")
}

/** Derive the repo root from a workspace path (the parent of the key directory). */
export function repoRootOf(workspace: Workspace, fallback: string): string {
  const idx = workspace.path.lastIndexOf(`/${workspace.key}`)
  return idx > 0 ? workspace.path.slice(0, idx) : fallback
}

async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    const entries = await readdir(path)
    if (entries.length === 0) {
      await rm(path, { recursive: true, force: true })
    }
  } catch {
    // Directory does not exist or cannot be inspected — ignore here and let git report real errors later.
  }
}

async function localBranchExists(root: string, branch: string): Promise<boolean> {
  const result = await runCommand("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root })
  return result.exitCode === 0
}

async function bootstrapMetadata(workspacePath: string, issue: Issue, branch: string): Promise<void> {
  // Create metadata directory after worktree.
  await mkdir(`${workspacePath}/.agent-valley/attempts`, { recursive: true })

  // Ensure .agent-valley is gitignored to prevent auto-commit conflicts across branches.
  const gitignorePath = `${workspacePath}/.gitignore`
  try {
    const existing = await readFile(gitignorePath, "utf-8").catch(() => "")
    if (!existing.includes(".agent-valley")) {
      const entry = existing.endsWith("\n") || existing === "" ? ".agent-valley/\n" : "\n.agent-valley/\n"
      await writeFile(gitignorePath, existing + entry)
    }
  } catch {
    await writeFile(gitignorePath, ".agent-valley/\n")
  }

  // Store issue metadata for workspace lookup.
  await writeFile(
    `${workspacePath}/.agent-valley/issue.json`,
    JSON.stringify({ issueId: issue.id, identifier: issue.identifier, branch }),
  )
}

/** Create (or reuse) a git worktree under `root` for the given issue. */
export async function createWorkspace(root: string, issue: Issue): Promise<Workspace> {
  const key = deriveKey(issue.identifier)
  const path = `${root}/${key}`
  const branch = deriveBranchName(issue.identifier, issue.title)

  await removeEmptyDirectory(path)

  let { exitCode, stderr } = await runCommand("git", ["worktree", "add", path, "-b", branch], { cwd: root })

  if (exitCode !== 0 && (await localBranchExists(root, branch))) {
    await removeEmptyDirectory(path)
    const reuseResult = await runCommand("git", ["worktree", "add", path, branch], { cwd: root })
    exitCode = reuseResult.exitCode
    stderr = reuseResult.stderr
  }

  if (exitCode !== 0) {
    const existing = await getWorkspace(root, issue.id)
    if (existing) {
      logger.info("workspace-manager", "Reusing existing workspace", { issueId: issue.id, workspacePath: path })
      return existing
    }
    throw new Error(`git worktree add failed: ${stderr}\n  Fix: Ensure ${root} is a git repository`)
  }

  await bootstrapMetadata(path, issue, branch)

  const workspace: Workspace = {
    issueId: issue.id,
    path,
    key,
    branch,
    status: "idle",
    createdAt: new Date().toISOString(),
  }

  logger.info("workspace-manager", "Workspace created", { issueId: issue.id, workspacePath: path })
  return workspace
}

/** Scan `root` for a workspace whose metadata matches `issueId`. */
export async function getWorkspace(root: string, issueId: string): Promise<Workspace | null> {
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return null
  }

  for (const entry of entries) {
    const metaFile = `${root}/${entry}/.agent-valley/issue.json`
    try {
      const raw = await readFile(metaFile, "utf-8")
      const meta = JSON.parse(raw) as { issueId: string; branch?: string; identifier?: string }
      if (meta.issueId === issueId) {
        return {
          issueId,
          path: `${root}/${entry}`,
          key: entry,
          branch: meta.branch ?? `feature/${meta.identifier ?? entry}`,
          status: "idle",
          createdAt: new Date().toISOString(),
        }
      }
    } catch {
      // No metadata — skip.
    }
  }
  return null
}

/** Persist a run attempt record inside the workspace metadata directory. */
export async function saveAttempt(workspace: Workspace, attempt: RunAttempt): Promise<void> {
  const path = `${workspace.path}/.agent-valley/attempts/${attempt.id}.json`
  await writeFile(path, JSON.stringify(attempt, null, 2), "utf-8")
}

/** Remove the git worktree and its directory. Tolerates already-removed directories. */
export async function cleanupWorkspace(workspace: Workspace, rootFallback: string): Promise<void> {
  const root = repoRootOf(workspace, rootFallback)
  await runCommand("git", ["worktree", "remove", workspace.path, "--force"], { cwd: root })
  await rm(workspace.path, { recursive: true, force: true })

  logger.info("workspace-manager", "Workspace cleaned up", {
    issueId: workspace.issueId,
    workspacePath: workspace.path,
  })
}

/** Booleans describing uncommitted + branch-diff state vs `main`. */
export async function detectUnfinishedWork(
  workspace: Workspace,
): Promise<{ hasUncommittedChanges: boolean; hasCodeChanges: boolean }> {
  const cwd = workspace.path

  const { stdout: statusOut } = await runCommand("git", ["status", "--porcelain"], { cwd })
  const hasUncommittedChanges = statusOut.trim().length > 0

  const { exitCode: diffExit } = await runCommand("git", ["diff", "--quiet", "main...HEAD"], { cwd })
  const hasBranchDiff = diffExit !== 0

  return {
    hasUncommittedChanges,
    hasCodeChanges: hasUncommittedChanges || hasBranchDiff,
  }
}

/** Return the last line of `git diff --stat main...HEAD` (the summary), or null when clean. */
export async function getDiffStat(workspace: Workspace): Promise<string | null> {
  const { stdout } = await runCommand("git", ["diff", "--stat", "main...HEAD"], { cwd: workspace.path })
  const lines = stdout.trim().split("\n")
  return lines.length > 0 ? lines[lines.length - 1]?.trim() || null : null
}
