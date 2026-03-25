/**
 * Workspace Manager — git worktree creation, merge, cleanup, and lifecycle management.
 *
 * All git operations run against the WORKSPACE_ROOT repo (not the agent-valley repo).
 */

import { spawn } from "node:child_process"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import type { Issue, RunAttempt, Workspace } from "../domain/models"
import { logger } from "../observability/logger"
import { buildConflictDiagnostics, getUnmergedFiles, isHighRiskFile, scanConflictMarkers } from "./conflict-guard"

/** Run a command and return its exit code, stdout, and stderr. */
export function runCommand(
  cmd: string,
  args: string[],
  options: { cwd?: string; ignoreStdio?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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

/**
 * Derive a git branch name from issue identifier + title.
 * Maps conventional commit prefix to git branch prefix.
 * Falls back to "feature" if no recognized prefix found.
 *
 * Allowed prefixes: feature, fix, refactor, hotfix, release
 *
 * Examples:
 *   "feat(web): add login" + "FIR-49"     → "feature/FIR-49"
 *   "fix(api): null pointer" + "FIR-50"   → "fix/FIR-50"
 *   "refactor: rename module" + "FIR-51"   → "refactor/FIR-51"
 *   "chore: update deps" + "FIR-52"       → "feature/FIR-52"
 */
const BRANCH_PREFIX_MAP: Record<string, string> = {
  feat: "feature",
  fix: "fix",
  hotfix: "hotfix",
  refactor: "refactor",
  release: "release",
}

export function deriveBranchName(identifier: string, title: string): string {
  const match = title.match(/^(\w+)[\s(:]/)
  const prefix = match ? (BRANCH_PREFIX_MAP[match[1] ?? ""] ?? "feature") : "feature"
  return `${prefix}/${identifier}`
}

export class WorkspaceManager {
  constructor(private rootPath: string) {}

  deriveKey(identifier: string): string {
    return identifier.replace(/[^A-Za-z0-9._-]/g, "_")
  }

  async create(issue: Issue, rootOverride?: string): Promise<Workspace> {
    const root = rootOverride ?? this.rootPath
    const key = this.deriveKey(issue.identifier)
    const path = `${root}/${key}`
    const branch = deriveBranchName(issue.identifier, issue.title)

    // Create git worktree from the target repo
    const { exitCode, stderr } = await runCommand("git", ["worktree", "add", path, "-b", branch], { cwd: root })

    if (exitCode !== 0) {
      // Worktree might already exist — try reusing
      const existing = await this.get(issue.id)
      if (existing) {
        logger.info("workspace-manager", "Reusing existing workspace", { issueId: issue.id, workspacePath: path })
        return existing
      }
      throw new Error(`git worktree add failed: ${stderr}\n  Fix: Ensure ${this.rootPath} is a git repository`)
    }

    // Create metadata directory after worktree
    await mkdir(`${path}/.agent-valley/attempts`, { recursive: true })

    // Ensure .agent-valley is gitignored to prevent auto-commit conflicts across branches
    const gitignorePath = `${path}/.gitignore`
    try {
      const existing = await readFile(gitignorePath, "utf-8").catch(() => "")
      if (!existing.includes(".agent-valley")) {
        const entry = existing.endsWith("\n") || existing === "" ? ".agent-valley/\n" : "\n.agent-valley/\n"
        await writeFile(gitignorePath, existing + entry)
      }
    } catch {
      await writeFile(gitignorePath, ".agent-valley/\n")
    }

    // Store issue metadata for workspace lookup
    await writeFile(
      `${path}/.agent-valley/issue.json`,
      JSON.stringify({ issueId: issue.id, identifier: issue.identifier, branch }),
    )

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

  async get(issueId: string): Promise<Workspace | null> {
    // Scan existing workspaces — match by issueId stored in metadata
    let entries: string[]
    try {
      entries = await readdir(this.rootPath)
    } catch {
      return null
    }

    for (const entry of entries) {
      const metaFile = `${this.rootPath}/${entry}/.agent-valley/issue.json`
      try {
        const raw = await readFile(metaFile, "utf-8")
        const meta = JSON.parse(raw) as { issueId: string; branch?: string; identifier?: string }
        if (meta.issueId === issueId) {
          return {
            issueId,
            path: `${this.rootPath}/${entry}`,
            key: entry,
            branch: meta.branch ?? `feature/${meta.identifier ?? entry}`,
            status: "idle",
            createdAt: new Date().toISOString(),
          }
        }
      } catch {
        // No metadata — skip
      }
    }
    return null
  }

  async saveAttempt(workspace: Workspace, attempt: RunAttempt): Promise<void> {
    const path = `${workspace.path}/.agent-valley/attempts/${attempt.id}.json`
    await writeFile(path, JSON.stringify(attempt, null, 2), "utf-8")
  }

  /** Derive the git repo root from a workspace path (parent of the workspace key dir). */
  private repoRoot(workspace: Workspace): string {
    // workspace.path = "{repoRoot}/{key}", so strip the last segment
    const idx = workspace.path.lastIndexOf(`/${workspace.key}`)
    return idx > 0 ? workspace.path.slice(0, idx) : this.rootPath
  }

  async mergeAndPush(workspace: Workspace): Promise<{ ok: boolean; error?: string }> {
    const root = this.repoRoot(workspace)
    const branch = workspace.branch
    const maxAttempts = 3

    const hasRemote = (await runCommand("git", ["remote", "get-url", "origin"], { cwd: root })).exitCode === 0

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // 1. Update main to latest
      if (hasRemote) {
        await runCommand("git", ["checkout", "main"], { cwd: root })
        await runCommand("git", ["pull", "--ff-only", "origin", "main"], { cwd: root })
      }

      // Save pre-merge ref for post-merge validation
      const { stdout: preRef } = await runCommand("git", ["rev-parse", "main"], { cwd: root })
      const preMainRef = preRef.trim()

      // 2. Check if branch has any commits ahead of main
      const { exitCode: diffExit } = await runCommand("git", ["diff", "--quiet", `main...${branch}`], { cwd: root })
      if (diffExit === 0) {
        logger.info("workspace-manager", "No changes to merge", { branch })
        return { ok: true }
      }

      // 3. Rebase feature branch onto latest main
      //    This puts agent's work on top of all other agents' merged work.
      //    If conflict: agent's code adapts to main, not the other way around.
      const { exitCode: rebaseExit, stderr: rebaseErr } = await runCommand("git", ["rebase", "main", branch], {
        cwd: root,
      })

      if (rebaseExit !== 0) {
        // rerere might resolve it
        const { exitCode: conflictCheck } = await runCommand("git", ["diff", "--check"], { cwd: root })
        if (conflictCheck !== 0) {
          // Auto-resolve: accept ours (= feature branch in rebase context)
          const resolved = await this.autoResolveRebaseConflicts(root, branch)
          if (!resolved) {
            await runCommand("git", ["rebase", "--abort"], { cwd: root })
            logger.error("workspace-manager", "Rebase failed with unresolved conflicts", { branch, error: rebaseErr })
            return { ok: false, error: `Rebase conflict on ${branch}: ${rebaseErr}` }
          }
        } else {
          // rerere resolved — continue rebase
          await runCommand("git", ["add", "."], { cwd: root })
          await runCommand("git", ["rebase", "--continue"], { cwd: root, env: { ...process.env, GIT_EDITOR: "true" } })
        }
      }

      // 4. Fast-forward merge into main (guaranteed clean after rebase)
      await runCommand("git", ["checkout", "main"], { cwd: root })
      const { exitCode: mergeExit } = await runCommand("git", ["merge", "--ff-only", branch], { cwd: root })
      if (mergeExit !== 0) {
        logger.warn("workspace-manager", "ff-only merge failed, falling back to regular merge", { branch })
        await runCommand("git", ["merge", branch, "--no-edit"], { cwd: root })
      }

      // 4b. Pre-push validation: scan merged content for conflict markers
      const { stdout: changedOut } = await runCommand("git", ["diff", "--name-only", `${preMainRef}..HEAD`], {
        cwd: root,
      })
      const changedInMerge = changedOut.trim().split("\n").filter(Boolean)
      if (changedInMerge.length > 0) {
        const markerFiles = await scanConflictMarkers(root, { ref: "HEAD", files: changedInMerge })
        if (markerFiles.length > 0) {
          logger.error("workspace-manager", "Delivery blocked: conflict markers in merged files", {
            branch,
            conflictFiles: markerFiles,
          })
          await runCommand("git", ["reset", "--hard", preMainRef], { cwd: root })
          return {
            ok: false,
            error: `Delivery blocked — conflict markers found in: ${markerFiles.join(", ")}. origin/main was NOT updated.`,
          }
        }
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

  /**
   * Auto-resolve rebase conflicts.
   * During rebase, "ours" = the branch being rebased onto (main),
   * "theirs" = the feature branch commits being replayed.
   * We accept "theirs" (feature branch) to preserve agent's work.
   */
  private async autoResolveRebaseConflicts(root: string, branch: string): Promise<boolean> {
    const { stdout: conflictList } = await runCommand("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: root })
    const conflictedFiles = conflictList
      .trim()
      .split("\n")
      .filter((f) => f.length > 0)

    if (conflictedFiles.length === 0) return false

    // Refuse auto-resolve for high-risk files (manifests, lockfiles)
    const highRisk = conflictedFiles.filter(isHighRiskFile)
    if (highRisk.length > 0) {
      logger.error("workspace-manager", "Auto-resolve refused for high-risk files", {
        branch,
        highRiskFiles: highRisk,
      })
      return false
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
        return false
      }
      await runCommand("git", ["add", file], { cwd: root })
    }

    // Continue the rebase
    const { exitCode: continueExit } = await runCommand("git", ["rebase", "--continue"], {
      cwd: root,
      env: { ...process.env, GIT_EDITOR: "true" },
    })

    if (continueExit !== 0) {
      // Might have more conflicts in subsequent commits — recurse
      const { exitCode: moreConflicts } = await runCommand("git", ["diff", "--check"], { cwd: root })
      if (moreConflicts !== 0) {
        return this.autoResolveRebaseConflicts(root, branch)
      }
    }

    logger.info("workspace-manager", `Auto-resolved rebase conflicts for ${branch}`)
    return true
  }

  /** Validate that the branch has no conflict markers in files changed from main. */
  async validateBranchContent(
    workspace: Workspace,
  ): Promise<{ ok: boolean; conflictFiles?: string[]; diagnostics?: string }> {
    const { stdout } = await runCommand("git", ["diff", "--name-only", "main...HEAD"], { cwd: workspace.path })
    const changed = stdout.trim().split("\n").filter(Boolean)
    if (!changed.length) return { ok: true }
    const bad = await scanConflictMarkers(workspace.path, { ref: "HEAD", files: changed })
    if (!bad.length) return { ok: true }
    return {
      ok: false,
      conflictFiles: bad,
      diagnostics: buildConflictDiagnostics(bad, "Conflict markers found in committed files"),
    }
  }

  // ── Safety-net: unfinished work detection ────────────────────────

  async detectUnfinishedWork(
    workspace: Workspace,
  ): Promise<{ hasUncommittedChanges: boolean; hasCodeChanges: boolean }> {
    const cwd = workspace.path

    // Uncommitted changes in working tree or index
    const { stdout: statusOut } = await runCommand("git", ["status", "--porcelain"], { cwd })
    const hasUncommittedChanges = statusOut.trim().length > 0

    // Any diff from main (committed changes on the branch)
    const { exitCode: diffExit } = await runCommand("git", ["diff", "--quiet", "main...HEAD"], { cwd })
    const hasBranchDiff = diffExit !== 0

    return {
      hasUncommittedChanges,
      hasCodeChanges: hasUncommittedChanges || hasBranchDiff,
    }
  }

  async autoCommit(workspace: Workspace): Promise<{ ok: boolean; conflictFiles?: string[]; diagnostics?: string }> {
    const cwd = workspace.path

    // Block: unmerged entries (active merge/rebase conflict state)
    const unmerged = await getUnmergedFiles(cwd)
    if (unmerged.length > 0) {
      logger.error("workspace-manager", "Auto-commit blocked: unmerged entries", {
        workspacePath: cwd,
        files: unmerged,
      })
      return {
        ok: false,
        conflictFiles: unmerged,
        diagnostics: buildConflictDiagnostics(unmerged, "Unmerged entries (active merge conflicts) found"),
      }
    }

    // Stage everything except metadata
    await runCommand("git", ["add", "-A", "--", ".", ":!.agent-valley"], { cwd })

    // Block: conflict markers in staged files
    const { stdout: stagedOut } = await runCommand("git", ["diff", "--cached", "--name-only"], { cwd })
    const stagedFiles = stagedOut.trim().split("\n").filter(Boolean)

    if (stagedFiles.length > 0) {
      const markerFiles = await scanConflictMarkers(cwd, { cached: true, files: stagedFiles })
      if (markerFiles.length > 0) {
        await runCommand("git", ["reset", "HEAD"], { cwd })
        logger.error("workspace-manager", "Auto-commit blocked: conflict markers in staged files", {
          workspacePath: cwd,
          conflictFiles: markerFiles,
        })
        return {
          ok: false,
          conflictFiles: markerFiles,
          diagnostics: buildConflictDiagnostics(markerFiles, "Conflict markers found in staged files"),
        }
      }
    }

    const { exitCode } = await runCommand("git", ["commit", "-m", "chore: auto-commit unfinished agent work"], { cwd })

    if (exitCode !== 0) {
      logger.warn("workspace-manager", "Auto-commit failed", { workspacePath: workspace.path })
      return { ok: false }
    }

    logger.info("workspace-manager", "Auto-committed unfinished work", { workspacePath: workspace.path })
    return { ok: true }
  }

  async getDiffStat(workspace: Workspace): Promise<string | null> {
    const { stdout } = await runCommand("git", ["diff", "--stat", "main...HEAD"], { cwd: workspace.path })
    const lines = stdout.trim().split("\n")
    return lines.length > 0 ? lines[lines.length - 1]?.trim() || null : null
  }

  async pushBranch(workspace: Workspace): Promise<{ ok: boolean; error?: string }> {
    const root = this.repoRoot(workspace)
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

  /** Safety-net: create a draft PR via gh CLI if one doesn't already exist for this branch */
  async createDraftPR(
    workspace: Workspace,
    opts: { title: string; body: string },
  ): Promise<{ created: boolean; url?: string }> {
    const root = this.repoRoot(workspace)
    const branch = workspace.branch

    // Check if PR already exists for this branch
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

    // Create draft PR
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

  async cleanup(workspace: Workspace): Promise<void> {
    const root = this.repoRoot(workspace)
    // Remove git worktree (from the target repo)
    await runCommand("git", ["worktree", "remove", workspace.path, "--force"], { cwd: root })

    // Remove directory if it still exists
    await rm(workspace.path, { recursive: true, force: true })

    logger.info("workspace-manager", "Workspace cleaned up", {
      issueId: workspace.issueId,
      workspacePath: workspace.path,
    })
  }
}
