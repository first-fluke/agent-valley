/**
 * Workspace Manager safety-net tests — detectUnfinishedWork, autoCommit, getDiffStat, pushBranch.
 * Uses a real temporary git repo to test actual git operations.
 */

import { execSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import type { Workspace } from "../domain/models"
import { WorkspaceManager } from "../workspace/workspace-manager"

let repoDir: string
let worktreeDir: string
let manager: WorkspaceManager
const branch = "feature/TEST-1"

function git(args: string, cwd?: string): string {
  return execSync(`git ${args}`, { cwd: cwd ?? repoDir, encoding: "utf-8" }).trim()
}

function makeWorkspace(): Workspace {
  return {
    issueId: "issue-1",
    path: worktreeDir,
    key: "TEST-1",
    branch: "feature/TEST-1",
    status: "running",
    createdAt: new Date().toISOString(),
  }
}

beforeEach(async () => {
  // Create a temporary git repo with an initial commit
  repoDir = await mkdtemp(join(tmpdir(), "symphony-test-repo-"))
  git("init -b main")
  git("config user.email test@test.com")
  git("config user.name Test")
  await writeFile(join(repoDir, "README.md"), "# Test\n")
  git("add .")
  git("commit -m 'initial commit'")

  // Create a worktree on the symphony branch
  worktreeDir = join(repoDir, "TEST-1")
  git(`worktree add ${worktreeDir} -b ${branch}`)

  manager = new WorkspaceManager(repoDir)
})

afterEach(async () => {
  try {
    git(`worktree remove ${worktreeDir} --force`)
  } catch {
    /* may already be removed */
  }
  await rm(repoDir, { recursive: true, force: true })
})

describe("detectUnfinishedWork", () => {
  test("clean worktree — no uncommitted, no code changes", async () => {
    const result = await manager.detectUnfinishedWork(makeWorkspace())

    expect(result.hasUncommittedChanges).toBe(false)
    expect(result.hasCodeChanges).toBe(false)
  })

  test("uncommitted new file — detects uncommitted changes", async () => {
    await writeFile(join(worktreeDir, "newfile.ts"), "console.log('hello')\n")

    const result = await manager.detectUnfinishedWork(makeWorkspace())

    expect(result.hasUncommittedChanges).toBe(true)
    expect(result.hasCodeChanges).toBe(true)
  })

  test("uncommitted modification — detects uncommitted changes", async () => {
    await writeFile(join(worktreeDir, "README.md"), "# Modified\n")

    const result = await manager.detectUnfinishedWork(makeWorkspace())

    expect(result.hasUncommittedChanges).toBe(true)
    expect(result.hasCodeChanges).toBe(true)
  })

  test("committed changes on branch — no uncommitted, has code changes", async () => {
    await writeFile(join(worktreeDir, "feature.ts"), "export const x = 1\n")
    git("add .", worktreeDir)
    git("commit -m 'add feature'", worktreeDir)

    const result = await manager.detectUnfinishedWork(makeWorkspace())

    expect(result.hasUncommittedChanges).toBe(false)
    expect(result.hasCodeChanges).toBe(true)
  })

  test("committed then reverted — no code changes", async () => {
    await writeFile(join(worktreeDir, "feature.ts"), "export const x = 1\n")
    git("add .", worktreeDir)
    git("commit -m 'add feature'", worktreeDir)
    git("rm feature.ts", worktreeDir)
    git("commit -m 'revert feature'", worktreeDir)

    const result = await manager.detectUnfinishedWork(makeWorkspace())

    expect(result.hasUncommittedChanges).toBe(false)
    // Branch has commits but net diff from main is zero
    expect(result.hasCodeChanges).toBe(false)
  })
})

describe("autoCommit", () => {
  test("commits all untracked and modified files", async () => {
    await writeFile(join(worktreeDir, "newfile.ts"), "console.log('hello')\n")
    await writeFile(join(worktreeDir, "README.md"), "# Updated\n")

    const result = await manager.autoCommit(makeWorkspace())

    expect(result.ok).toBe(true)

    // Verify committed
    const log = git("log --oneline -1", worktreeDir)
    expect(log).toContain("auto-commit unfinished agent work")

    // Verify clean working tree
    const status = git("status --porcelain", worktreeDir)
    expect(status).toBe("")
  })

  test("returns ok:false when nothing to commit", async () => {
    const result = await manager.autoCommit(makeWorkspace())

    expect(result.ok).toBe(false)
  })

  test("blocks auto-commit when conflict markers are present", async () => {
    await writeFile(
      join(worktreeDir, "feature.ts"),
      "<<<<<<< HEAD\nconst x = 1\n=======\nconst x = 2\n>>>>>>> branch\n",
    )

    const result = await manager.autoCommit(makeWorkspace())

    expect(result.ok).toBe(false)
    expect(result.error).toContain("Conflict markers detected")
    const log = git("log --oneline -1", worktreeDir)
    expect(log).not.toContain("auto-commit unfinished agent work")
    const status = git("status --porcelain", worktreeDir)
    expect(status).not.toBe("")
  })

  test("returns retryable failure for lockfile conflict markers", async () => {
    await writeFile(
      join(worktreeDir, "package-lock.json"),
      '<<<<<<< HEAD\n{\n  "name": "demo"\n}\n=======\n{\n  "name": "demo-app"\n}\n>>>>>>> branch\n',
    )

    const result = await manager.autoCommit(makeWorkspace())

    expect(result.ok).toBe(false)
    expect(result.retryable).toBe(true)
    expect(result.error).toContain("regeneratable lockfiles")
    expect(result.retryPrompt).toContain("dependency install or sync")
  })
})

describe("getDiffStat", () => {
  test("returns null for clean worktree", async () => {
    const result = await manager.getDiffStat(makeWorkspace())

    expect(result).toBeNull()
  })

  test("returns stat line for committed changes", async () => {
    await writeFile(join(worktreeDir, "feature.ts"), "export const x = 1\n")
    git("add .", worktreeDir)
    git("commit -m 'add feature'", worktreeDir)

    const result = await manager.getDiffStat(makeWorkspace())

    expect(result).not.toBeNull()
    expect(result).toContain("1 file changed")
    expect(result).toContain("insertion")
  })

  test("returns stat line for multiple files", async () => {
    await writeFile(join(worktreeDir, "a.ts"), "export const a = 1\n")
    await writeFile(join(worktreeDir, "b.ts"), "export const b = 2\n")
    git("add .", worktreeDir)
    git("commit -m 'add a and b'", worktreeDir)

    const result = await manager.getDiffStat(makeWorkspace())

    expect(result).not.toBeNull()
    expect(result).toContain("2 files changed")
  })
})

describe("pushBranch", () => {
  test("returns ok:true when no remote configured", async () => {
    // Our test repo has no remote — push should succeed silently
    const result = await manager.pushBranch(makeWorkspace())

    expect(result.ok).toBe(true)
  })

  test("pushes to remote when configured", async () => {
    // Create a bare remote repo
    const bareDir = await mkdtemp(join(tmpdir(), "symphony-test-bare-"))
    execSync(`git init --bare ${bareDir}`)
    git(`remote add origin ${bareDir}`)
    git("push -u origin main")

    // Make a commit on the branch
    await writeFile(join(worktreeDir, "feature.ts"), "export const x = 1\n")
    git("add .", worktreeDir)
    git("commit -m 'feature'", worktreeDir)

    const result = await manager.pushBranch(makeWorkspace())

    expect(result.ok).toBe(true)

    // Verify branch exists on remote
    const remoteBranches = execSync(`git -C ${bareDir} branch`, { encoding: "utf-8" })
    expect(remoteBranches).toContain(branch)

    await rm(bareDir, { recursive: true, force: true })
  })
})
