/**
 * Workspace Manager — git worktree creation, merge, cleanup, and lifecycle management.
 *
 * All git operations run against the WORKSPACE_ROOT repo (not the agent-valley repo).
 */

import { spawn } from "node:child_process"
import { readdir, readFile, mkdir, writeFile, rm } from "node:fs/promises"
import type { Issue, Workspace, RunAttempt } from "../domain/models"
import { logger } from "../observability/logger"

/** Run a command and return its exit code + stderr text. */
function runCommand(
  cmd: string,
  args: string[],
  options: { cwd?: string; ignoreStdio?: boolean } = {},
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd: options.cwd ?? process.cwd(),
      stdio: options.ignoreStdio ? "ignore" : ["ignore", "ignore", "pipe"],
    })

    let stderr = ""
    if (!options.ignoreStdio && proc.stderr) {
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString()
      })
    }

    proc.once("close", (code) => {
      resolve({ exitCode: code ?? -1, stderr })
    })
  })
}

export class WorkspaceManager {
  constructor(
    private rootPath: string,
    private retentionDays: number = 7,
  ) {}

  deriveKey(identifier: string): string {
    return identifier.replace(/[^A-Za-z0-9._-]/g, "_")
  }

  async create(issue: Issue, rootOverride?: string): Promise<Workspace> {
    const root = rootOverride ?? this.rootPath
    const key = this.deriveKey(issue.identifier)
    const path = `${root}/${key}`
    const branch = `symphony/${key}`

    // Create git worktree from the target repo
    const { exitCode, stderr } = await runCommand(
      "git",
      ["worktree", "add", path, "-b", branch],
      { cwd: root },
    )

    if (exitCode !== 0) {
      // Worktree might already exist — try reusing
      const existing = await this.get(issue.id)
      if (existing) {
        logger.info("workspace-manager", "Reusing existing workspace", { issueId: issue.id, workspacePath: path })
        return existing
      }
      throw new Error(`git worktree add failed: ${stderr}\n  Fix: Ensure ${this.rootPath} is a git repository`)
    }

    // Create .symphony metadata directory after worktree
    await mkdir(`${path}/.symphony/attempts`, { recursive: true })

    // Store issue metadata for workspace lookup
    await writeFile(`${path}/.symphony/issue.json`, JSON.stringify({ issueId: issue.id, identifier: issue.identifier }))

    const workspace: Workspace = {
      issueId: issue.id,
      path,
      key,
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
      const metaFile = `${this.rootPath}/${entry}/.symphony/issue.json`
      try {
        const raw = await readFile(metaFile, "utf-8")
        const meta = JSON.parse(raw) as { issueId: string }
        if (meta.issueId === issueId) {
          return {
            issueId,
            path: `${this.rootPath}/${entry}`,
            key: entry,
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
    const path = `${workspace.path}/.symphony/attempts/${attempt.id}.json`
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
    const branch = `symphony/${workspace.key}`

    // Check if branch has any commits ahead of main
    const { exitCode: diffExit } = await runCommand(
      "git", ["diff", "--quiet", `main...${branch}`],
      { cwd: root },
    )
    if (diffExit === 0) {
      logger.info("workspace-manager", "No changes to merge", { branch })
      return { ok: true }
    }

    // Merge branch into main (rerere handles conflict resolution)
    const { exitCode: mergeExit, stderr: mergeErr } = await runCommand(
      "git", ["merge", branch, "--no-edit"],
      { cwd: root },
    )
    if (mergeExit !== 0) {
      // rerere might have resolved, check for remaining conflicts
      const { exitCode: conflictCheck } = await runCommand(
        "git", ["diff", "--check"],
        { cwd: root },
      )
      if (conflictCheck !== 0) {
        await runCommand("git", ["merge", "--abort"], { cwd: root })
        logger.error("workspace-manager", "Merge failed with unresolved conflicts", { branch, error: mergeErr })
        return { ok: false, error: `Merge conflict on ${branch}: ${mergeErr}` }
      }
      // rerere resolved all conflicts — commit the resolution
      await runCommand("git", ["commit", "--no-edit"], { cwd: root })
    }

    // Push main (if remote exists)
    const { exitCode: remoteCheck } = await runCommand(
      "git", ["remote", "get-url", "origin"],
      { cwd: root },
    )
    if (remoteCheck === 0) {
      const { exitCode: pushExit, stderr: pushErr } = await runCommand(
        "git", ["push", "origin", "main"],
        { cwd: root },
      )
      if (pushExit !== 0) {
        logger.error("workspace-manager", "Push failed", { error: pushErr })
        return { ok: false, error: `Push failed: ${pushErr}` }
      }
    }

    // Delete the feature branch
    await runCommand("git", ["branch", "-D", branch], { cwd: root })

    logger.info("workspace-manager", "Merged and pushed", { branch })
    return { ok: true }
  }

  async cleanup(workspace: Workspace): Promise<void> {
    const root = this.repoRoot(workspace)
    // Remove git worktree (from the target repo)
    await runCommand("git", ["worktree", "remove", workspace.path, "--force"], { cwd: root })

    // Remove directory if it still exists
    await rm(workspace.path, { recursive: true, force: true })

    logger.info("workspace-manager", "Workspace cleaned up", { issueId: workspace.issueId, workspacePath: workspace.path })
  }
}
