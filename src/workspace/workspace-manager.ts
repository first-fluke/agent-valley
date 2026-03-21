/**
 * Workspace Manager — git worktree creation, cleanup, and lifecycle management.
 */

import { spawn } from "node:child_process"
import { readdir, mkdir, writeFile, rm, access } from "node:fs/promises"
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
    // Replace non-safe chars, then collapse consecutive dots to prevent path traversal
    return identifier
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .replace(/\.{2,}/g, ".")
  }

  async create(issue: Issue): Promise<Workspace> {
    const key = this.deriveKey(issue.identifier)
    const path = `${this.rootPath}/${key}`
    const branch = `symphony/${key}`

    // Create git worktree first (it creates the directory)
    const { exitCode, stderr } = await runCommand(
      "git",
      ["worktree", "add", path, "-b", branch],
      { cwd: process.cwd() },
    )

    if (exitCode !== 0) {
      // Worktree might already exist — try reusing
      const existing = await this.get(issue.id)
      if (existing) {
        logger.info("workspace-manager", "Reusing existing workspace", { issueId: issue.id, workspacePath: path })
        return existing
      }
      throw new Error(`git worktree add failed: ${stderr}\n  Fix: Ensure ${this.rootPath} is inside a git repository`)
    }

    // Create .symphony metadata directory after worktree
    await mkdir(`${path}/.symphony/attempts`, { recursive: true })

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
    // Scan existing workspaces
    let entries: string[]
    try {
      entries = await readdir(this.rootPath)
    } catch {
      return null
    }

    for (const entry of entries) {
      const gitFile = `${this.rootPath}/${entry}/.git`
      const exists = await access(gitFile).then(() => true).catch(() => false)
      if (exists) {
        // Found a worktree — check if it matches the issueId
        // In practice, we store issueId in the workspace metadata
        // For now, return based on directory existence
        return {
          issueId,
          path: `${this.rootPath}/${entry}`,
          key: entry,
          status: "idle",
          createdAt: new Date().toISOString(),
        }
      }
    }
    return null
  }

  async saveAttempt(workspace: Workspace, attempt: RunAttempt): Promise<void> {
    const path = `${workspace.path}/.symphony/attempts/${attempt.id}.json`
    await writeFile(path, JSON.stringify(attempt, null, 2), "utf-8")
  }

  async cleanup(workspace: Workspace): Promise<void> {
    // Remove git worktree
    await runCommand("git", ["worktree", "remove", workspace.path, "--force"])

    // Remove directory if it still exists
    await rm(workspace.path, { recursive: true, force: true })

    logger.info("workspace-manager", "Workspace cleaned up", { issueId: workspace.issueId, workspacePath: workspace.path })
  }
}
