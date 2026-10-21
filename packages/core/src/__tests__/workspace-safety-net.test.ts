/**
 * Workspace Manager safety-net tests — detectUnfinishedWork, autoCommit, getDiffStat, pushBranch.
 * Uses a real temporary git repo to test actual git operations.
 */

import { execSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import type { Issue, Workspace } from "../domain/models"
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

describe("create", () => {
  test("re-attaches an existing branch when stale branch metadata remains", async () => {
    const issue: Issue = {
      id: "issue-2",
      identifier: "TEST-2",
      title: "fix: resume stale branch",
      description: "",
      status: { id: "state-todo", name: "Todo", type: "unstarted" },
      team: { id: "team-1", key: "TEST" },
      labels: [],
      url: "https://example.test/TEST-2",
      score: null,
      parentId: null,
      children: [],
      relations: [],
    }

    git("checkout -b fix/TEST-2", repoDir)
    git("checkout main", repoDir)

    const stalePath = join(repoDir, "TEST-2")
    await mkdir(stalePath, { recursive: true })

    const workspace = await manager.create(issue)

    expect(workspace.branch).toBe("fix/TEST-2")
    expect(workspace.path).toBe(stalePath)

    const currentBranch = git("branch --show-current", stalePath)
    expect(currentBranch).toBe("fix/TEST-2")
  })

  test("reuses an existing workspace when routed through a root override", async () => {
    const issue: Issue = {
      id: "issue-3",
      identifier: "TEST-3",
      title: "fix: reuse existing routed workspace",
      description: "",
      status: { id: "state-todo", name: "Todo", type: "unstarted" },
      team: { id: "team-1", key: "TEST" },
      labels: [],
      url: "https://example.test/TEST-3",
      score: null,
      parentId: null,
      children: [],
      relations: [],
    }

    const routedManager = new WorkspaceManager(join(repoDir, "unrelated-root"))
    const routedPath = join(repoDir, "TEST-3")
    await manager.create(issue)

    const workspace = await routedManager.create(issue, repoDir)

    expect(workspace.path).toBe(routedPath)
    expect(workspace.branch).toBe("fix/TEST-3")
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

describe("agent-writable git metadata", () => {
  test("does not execute repository hooks during auto-commit", async () => {
    const marker = join(repoDir, "hook-ran.txt")
    await mkdir(join(repoDir, ".git", "hooks"), { recursive: true })
    await writeFile(join(repoDir, ".git", "hooks", "pre-commit"), `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`, {
      mode: 0o755,
    })
    await writeFile(join(worktreeDir, "change.ts"), "export const x = 1\n")

    const result = await manager.autoCommit(makeWorkspace())

    expect(result.ok).toBe(true)
    expect(existsSync(marker)).toBe(false)
  })

  test("rejects a .git pointer to a repository outside the configured root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "symphony-outside-git-"))
    const fakeGitDir = join(outside, "worktrees", "TEST-1")
    await mkdir(fakeGitDir, { recursive: true })
    await rm(join(worktreeDir, ".git"), { force: true })
    await writeFile(join(worktreeDir, ".git"), `gitdir: ${fakeGitDir}\n`)
    await writeFile(join(worktreeDir, "change.ts"), "export const x = 1\n")

    const result = await manager.autoCommit(makeWorkspace())

    expect(result.ok).toBe(false)
    expect(result.error).toContain("outside the configured repository")
    await rm(outside, { recursive: true, force: true })
  })

  test("rejects a .git file that points inside the workspace", async () => {
    const fakeGitDir = join(worktreeDir, "fake-git")
    await mkdir(join(fakeGitDir, "worktrees", "TEST-1"), { recursive: true })
    await rm(join(worktreeDir, ".git"), { force: true })
    await writeFile(join(worktreeDir, ".git"), `gitdir: ${join(fakeGitDir, "worktrees", "TEST-1")}\n`)

    const result = await manager.autoCommit(makeWorkspace())

    expect(result.ok).toBe(false)
    expect(result.error).toContain("points inside the agent-writable workspace")
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
