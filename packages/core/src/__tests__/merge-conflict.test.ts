/**
 * Merge delivery tests — rebase-based workflow with conflict auto-resolution.
 * Creates real git repos to verify workspace manager's mergeAndPush.
 */

import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { WorkspaceManager } from "../workspace/workspace-manager"

function git(cwd: string, args: string[]): string {
  return execSync(["git", ...args].map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" "), {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim()
}

function readFile(path: string): string {
  return execSync(`cat ${path}`, { encoding: "utf-8" })
}

describe("mergeAndPush — rebase-based delivery", () => {
  let tmpDir: string
  let bareDir: string
  let repoDir: string
  let manager: WorkspaceManager

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), "av-merge-test-"))
    bareDir = resolve(tmpDir, "bare.git")
    repoDir = resolve(tmpDir, "repo")

    // Create bare remote with main as default branch
    mkdirSync(bareDir)
    git(bareDir, ["init", "--bare", "--initial-branch=main"])

    // Clone
    execSync(`git clone ${bareDir} ${repoDir}`, { stdio: "pipe" })
    git(repoDir, ["config", "user.email", "test@test.com"])
    git(repoDir, ["config", "user.name", "Test"])
    git(repoDir, ["config", "rerere.enabled", "true"])
    git(repoDir, ["checkout", "-b", "main"])

    writeFileSync(resolve(repoDir, "file.txt"), "line 1\nline 2\nline 3\n")
    git(repoDir, ["add", "."])
    git(repoDir, ["commit", "-m", "initial"])
    git(repoDir, ["push", "-u", "origin", "main"])

    manager = new WorkspaceManager(repoDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("rebases feature branch and fast-forward merges", async () => {
    // Feature branch
    git(repoDir, ["checkout", "-b", "feature/TEST-1"])
    writeFileSync(resolve(repoDir, "feature.txt"), "feature content\n")
    git(repoDir, ["add", "."])
    git(repoDir, ["commit", "-m", "feat: add feature"])

    // Meanwhile, main advances
    git(repoDir, ["checkout", "main"])
    writeFileSync(resolve(repoDir, "other.txt"), "other content\n")
    git(repoDir, ["add", "."])
    git(repoDir, ["commit", "-m", "chore: add other"])
    git(repoDir, ["push", "origin", "main"])

    const workspace = {
      id: "t",
      key: "TEST-1",
      path: resolve(repoDir, "TEST-1"),
      issueId: "t",
      branch: "feature/TEST-1",
      status: "running" as const,
      createdAt: new Date().toISOString(),
    }
    const result = await manager.mergeAndPush(workspace)

    expect(result.ok).toBe(true)

    // Both files should exist on main
    git(repoDir, ["checkout", "main"])
    expect(readFile(resolve(repoDir, "feature.txt"))).toContain("feature content")
    expect(readFile(resolve(repoDir, "other.txt"))).toContain("other content")
  })

  test("auto-resolves rebase conflict (feature branch wins)", { timeout: 10000 }, async () => {
    // Feature branch modifies line 2
    git(repoDir, ["checkout", "-b", "feature/TEST-2"])
    writeFileSync(resolve(repoDir, "file.txt"), "line 1\nfeature change\nline 3\n")
    git(repoDir, ["add", "."])
    git(repoDir, ["commit", "-m", "feat: change line 2"])

    // Main also modifies line 2 (conflict!)
    git(repoDir, ["checkout", "main"])
    writeFileSync(resolve(repoDir, "file.txt"), "line 1\nmain change\nline 3\n")
    git(repoDir, ["add", "."])
    git(repoDir, ["commit", "-m", "chore: change line 2"])
    git(repoDir, ["push", "origin", "main"])

    const workspace = {
      id: "t",
      key: "TEST-2",
      path: resolve(repoDir, "TEST-2"),
      issueId: "t",
      branch: "feature/TEST-2",
      status: "running" as const,
      createdAt: new Date().toISOString(),
    }
    const result = await manager.mergeAndPush(workspace)

    expect(result.ok).toBe(true)

    // Feature branch version wins (theirs in rebase context)
    git(repoDir, ["checkout", "main"])
    expect(readFile(resolve(repoDir, "file.txt"))).toContain("feature change")
  })

  test("clean merge with no changes returns ok", async () => {
    git(repoDir, ["checkout", "-b", "feature/TEST-3"])
    // No changes
    git(repoDir, ["checkout", "main"])

    const workspace = {
      id: "t",
      key: "TEST-3",
      path: resolve(repoDir, "TEST-3"),
      issueId: "t",
      branch: "feature/TEST-3",
      status: "running" as const,
      createdAt: new Date().toISOString(),
    }
    const result = await manager.mergeAndPush(workspace)

    expect(result.ok).toBe(true)
  })
})
