/**
 * Merge conflict auto-resolution tests.
 * Creates real git repos to test the workspace manager's conflict handling.
 */

import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { WorkspaceManager } from "../workspace/workspace-manager"

function git(cwd: string, ...args: string[]): string {
  const escaped = args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")
  return execSync(`git ${escaped}`, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim()
}

describe("mergeAndPush — conflict auto-resolution", () => {
  let tmpDir: string
  let bareDir: string
  let repoDir: string
  let manager: WorkspaceManager

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), "av-merge-test-"))
    bareDir = resolve(tmpDir, "bare.git")
    repoDir = resolve(tmpDir, "repo")

    // Create bare remote
    mkdirSync(bareDir)
    git(bareDir, "init", "--bare")

    // Clone and set up main branch
    git(bareDir, "config", "init.defaultBranch", "main")
    // Re-init bare with main as default
    rmSync(bareDir, { recursive: true, force: true })
    mkdirSync(bareDir)
    git(bareDir, "init", "--bare", "--initial-branch=main")

    execSync(`git clone ${bareDir} ${repoDir}`, { stdio: "pipe" })
    git(repoDir, "config", "user.email", "test@test.com")
    git(repoDir, "config", "user.name", "Test")
    git(repoDir, "config", "rerere.enabled", "true")
    git(repoDir, "checkout", "-b", "main")

    writeFileSync(resolve(repoDir, "file.txt"), "line 1\nline 2\nline 3\n")
    git(repoDir, "add", ".")
    git(repoDir, "commit", "-m", "initial")
    git(repoDir, "push", "-u", "origin", "main")

    manager = new WorkspaceManager(repoDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("auto-resolves conflict with theirs strategy", async () => {
    // Create a feature branch with a change
    git(repoDir, "checkout", "-b", "symphony/TEST-1")
    writeFileSync(resolve(repoDir, "file.txt"), "line 1\nfeature change\nline 3\n")
    git(repoDir, "add", ".")
    git(repoDir, "commit", "-m", "feature: change line 2")

    // Go back to main and create a conflicting change
    git(repoDir, "checkout", "main")
    writeFileSync(resolve(repoDir, "file.txt"), "line 1\nmain change\nline 3\n")
    git(repoDir, "add", ".")
    git(repoDir, "commit", "-m", "main: change line 2")
    git(repoDir, "push", "origin", "main")

    // Attempt merge — should auto-resolve with theirs
    const workspace = { id: "test", key: "TEST-1", path: resolve(repoDir, "TEST-1"), issueId: "test-id" }
    const result = await manager.mergeAndPush(workspace)

    expect(result.ok).toBe(true)

    // Verify the feature branch version won (theirs)
    const content = execSync(`cat ${resolve(repoDir, "file.txt")}`, { encoding: "utf-8" })
    expect(content).toContain("feature change")
  })

  test("handles no-conflict merge cleanly", async () => {
    // Create a feature branch with a non-conflicting change
    git(repoDir, "checkout", "-b", "symphony/TEST-2")
    writeFileSync(resolve(repoDir, "new-file.txt"), "new content\n")
    git(repoDir, "add", ".")
    git(repoDir, "commit", "-m", "feature: add new file")

    git(repoDir, "checkout", "main")

    const workspace = { id: "test", key: "TEST-2", path: resolve(repoDir, "TEST-2"), issueId: "test-id" }
    const result = await manager.mergeAndPush(workspace)

    expect(result.ok).toBe(true)
  })
})
