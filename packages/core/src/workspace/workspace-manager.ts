/**
 * Workspace Manager — git worktree creation, merge, cleanup, and lifecycle management.
 *
 * All git operations run against the WORKSPACE_ROOT repo (not the agent-valley repo).
 */

import { spawn } from "node:child_process"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import type { Issue, RunAttempt, Workspace } from "../domain/models"
import { logger } from "../observability/logger"

interface WorkspaceValidationResult {
  ok: boolean
  error?: string
  retryable?: boolean
  retryPrompt?: string
}

const CONFLICT_MARKER_PATTERN = /^(<<<<<<<|=======|>>>>>>>)( .*)?$/m

const REGENERATABLE_LOCKFILE_PATTERNS = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)bun\.lockb?$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)uv\.lock$/,
  /(^|\/)go\.sum$/,
]

const HIGH_RISK_CONFLICT_PATTERNS = [
  /(^|\/)package\.json$/,
  /(^|\/)pyproject\.toml$/,
  /(^|\/)go\.mod$/,
  /(^|\/)(middleware|auth|auth-client|auth-server|env|config)\.[^/]+$/,
  /(^|\/)auth\//,
]

/** Run a command and return its exit code, stdout, and stderr. */
function runCommand(
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

  private async removeEmptyDirectory(path: string): Promise<void> {
    try {
      const entries = await readdir(path)
      if (entries.length === 0) {
        await rm(path, { recursive: true, force: true })
      }
    } catch {
      // Directory does not exist or cannot be inspected — ignore here and let git report real errors later.
    }
  }

  private async localBranchExists(root: string, branch: string): Promise<boolean> {
    const result = await runCommand("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root })
    return result.exitCode === 0
  }

  async create(issue: Issue, rootOverride?: string): Promise<Workspace> {
    const root = rootOverride ?? this.rootPath
    const key = this.deriveKey(issue.identifier)
    const path = `${root}/${key}`
    const branch = deriveBranchName(issue.identifier, issue.title)

    await this.removeEmptyDirectory(path)

    // Create git worktree from the target repo
    let { exitCode, stderr } = await runCommand("git", ["worktree", "add", path, "-b", branch], { cwd: root })

    if (exitCode !== 0 && (await this.localBranchExists(root, branch))) {
      await this.removeEmptyDirectory(path)
      const reuseResult = await runCommand("git", ["worktree", "add", path, branch], { cwd: root })
      exitCode = reuseResult.exitCode
      stderr = reuseResult.stderr
    }

    if (exitCode !== 0) {
      // Worktree might already exist — try reusing
      const existing = await this.get(issue.id, root)
      if (existing) {
        logger.info("workspace-manager", "Reusing existing workspace", { issueId: issue.id, workspacePath: path })
        return existing
      }
      throw new Error(`git worktree add failed: ${stderr}\n  Fix: Ensure ${root} is a git repository`)
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

  async get(issueId: string, rootOverride?: string): Promise<Workspace | null> {
    const root = rootOverride ?? this.rootPath

    // Scan existing workspaces — match by issueId stored in metadata
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

  private parseNullSeparatedPaths(output: string): string[] {
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

  private isHighRiskConflictFile(file: string): boolean {
    return HIGH_RISK_CONFLICT_PATTERNS.some((pattern) => pattern.test(file))
  }

  private isRegeneratableLockfile(file: string): boolean {
    return REGENERATABLE_LOCKFILE_PATTERNS.some((pattern) => pattern.test(file))
  }

  private buildLockfileRetryPrompt(files: string[]): string {
    return [
      `Lockfile conflicts require regeneration in: ${files.join(", ")}`,
      "Retry instruction:",
      "- Sync your branch with the latest main changes before resolving the dependency graph.",
      "- Run the repo's dependency install or sync command to regenerate the conflicted lockfile(s).",
      "- Review the regenerated lockfile diff and keep only intentional dependency updates.",
    ].join("\n")
  }

  private classifyConflictFiles(
    files: string[],
    options: {
      retryablePrefix: string
      retryableFix: string
      manualPrefix: string
      manualFix: string
    },
  ): WorkspaceValidationResult {
    const lockfiles = files.filter((file) => this.isRegeneratableLockfile(file))
    if (lockfiles.length === files.length) {
      return {
        ok: false,
        retryable: true,
        error: `${options.retryablePrefix}: ${lockfiles.join(", ")}\n  Fix: ${options.retryableFix}`,
        retryPrompt: this.buildLockfileRetryPrompt(lockfiles),
      }
    }

    return {
      ok: false,
      error: `${options.manualPrefix}: ${files.join(", ")}\n  Fix: ${options.manualFix}`,
    }
  }

  private async findConflictMarkerFiles(root: string, files: string[]): Promise<string[]> {
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

  private async validateWorktreeBeforeAutoCommit(cwd: string): Promise<WorkspaceValidationResult> {
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
    const changedFiles = this.parseNullSeparatedPaths(statusOut).filter((file) => !file.startsWith(".agent-valley/"))
    const conflictMarkerFiles = await this.findConflictMarkerFiles(cwd, changedFiles)
    if (conflictMarkerFiles.length > 0) {
      return this.classifyConflictFiles(conflictMarkerFiles, {
        retryablePrefix: "Conflict markers detected in regeneratable lockfiles",
        retryableFix: "Regenerate the lockfile before auto-commit.",
        manualPrefix: "Conflict markers detected in changed files",
        manualFix: "Resolve the conflict markers before auto-commit.",
      })
    }

    await runCommand("git", ["add", "-A", "--", ".", ":!.agent-valley"], { cwd })

    const { stdout: stagedOut } = await runCommand("git", ["diff", "--cached", "--name-only", "-z"], { cwd })
    const stagedFiles = this.parseNullSeparatedPaths(stagedOut).filter((file) => !file.startsWith(".agent-valley/"))
    const stagedConflictFiles = await this.findConflictMarkerFiles(cwd, stagedFiles)
    if (stagedConflictFiles.length > 0) {
      await runCommand("git", ["reset"], { cwd })
      return this.classifyConflictFiles(stagedConflictFiles, {
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

  private async validateBranchBeforeMerge(root: string, branch: string): Promise<WorkspaceValidationResult> {
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
    const conflictMarkerFiles = await this.findConflictMarkerFiles(root, changedFiles)
    if (conflictMarkerFiles.length > 0) {
      return this.classifyConflictFiles(conflictMarkerFiles, {
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

  async mergeAndPush(
    workspace: Workspace,
  ): Promise<{ ok: boolean; error?: string; retryable?: boolean; retryPrompt?: string }> {
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

      // 2. Check if branch has any commits ahead of main
      const { exitCode: diffExit } = await runCommand("git", ["diff", "--quiet", `main...${branch}`], { cwd: root })
      if (diffExit === 0) {
        logger.info("workspace-manager", "No changes to merge", { branch })
        return { ok: true }
      }

      const preRebaseValidation = await this.validateBranchBeforeMerge(root, branch)
      if (!preRebaseValidation.ok) {
        logger.error("workspace-manager", "Branch validation failed before merge delivery", {
          branch,
          error: preRebaseValidation.error,
        })
        return { ok: false, error: preRebaseValidation.error }
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

      const postRebaseValidation = await this.validateBranchBeforeMerge(root, branch)
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

  /**
   * Auto-resolve rebase conflicts.
   * During rebase, "ours" = the branch being rebased onto (main),
   * "theirs" = the feature branch commits being replayed.
   * We accept "theirs" (feature branch) to preserve agent's work.
   */
  private async autoResolveRebaseConflicts(
    root: string,
    branch: string,
  ): Promise<{ ok: boolean; error?: string; retryable?: boolean; retryPrompt?: string }> {
    const { stdout: conflictList } = await runCommand("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: root })
    const conflictedFiles = conflictList
      .trim()
      .split("\n")
      .filter((f) => f.length > 0)

    if (conflictedFiles.length === 0) return { ok: false, error: `Rebase conflict on ${branch}` }

    const lockfiles = conflictedFiles.filter((file) => this.isRegeneratableLockfile(file))
    if (lockfiles.length === conflictedFiles.length) {
      logger.warn("workspace-manager", "Deferring lockfile rebase conflicts to agent retry", {
        branch,
        files: lockfiles.join(", "),
      })
      return {
        ok: false,
        retryable: true,
        error: `Rebase conflicted in regeneratable lockfiles: ${lockfiles.join(", ")}`,
        retryPrompt: this.buildLockfileRetryPrompt(lockfiles),
      }
    }

    const highRiskFiles = conflictedFiles.filter((file) => this.isHighRiskConflictFile(file))
    if (highRiskFiles.length > 0 || lockfiles.length > 0) {
      logger.warn("workspace-manager", "Refusing to auto-resolve high-risk rebase conflicts", {
        branch,
        files: [...new Set([...highRiskFiles, ...lockfiles])].join(", "),
      })
      return {
        ok: false,
        error: `Rebase conflict on ${branch}: ${[...new Set([...highRiskFiles, ...lockfiles])].join(", ")}`,
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
    return { ok: true }
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

  async autoCommit(
    workspace: Workspace,
  ): Promise<{ ok: boolean; error?: string; retryable?: boolean; retryPrompt?: string }> {
    const cwd = workspace.path

    const validation = await this.validateWorktreeBeforeAutoCommit(cwd)
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
