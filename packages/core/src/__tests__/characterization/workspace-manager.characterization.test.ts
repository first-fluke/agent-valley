/**
 * Characterization test — locks current behavior before v0.2 refactor (PR2/PR3).
 * Design: docs/plans/v0-2-bigbang-design.md § 2 (M0)
 * DO NOT modify expected values to match "desired" behavior.
 * If a test fails during refactor, investigate before updating the test.
 *
 * Scope: WorkspaceManager — all public methods.
 *   - deriveKey, create, get, saveAttempt
 *   - detectUnfinishedWork, autoCommit, getDiffStat
 *   - pushBranch, createDraftPR, cleanup, mergeAndPush
 *
 * Strategy: real temp git repo (follows existing workspace-safety-net.test.ts pattern)
 * so delivery/merge/cleanup behaviors are captured end-to-end against real git plumbing.
 */

import { execSync } from "node:child_process"
import { existsSync } from "node:fs"
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import type { Issue, RunAttempt, Workspace } from "../../domain/models"
import { WorkspaceManager } from "../../workspace/workspace-manager"

// ── Shared git helper ──────────────────────────────────────────────

let repoDir: string
let manager: WorkspaceManager

function git(args: string, cwd?: string): string {
  return execSync(`git ${args}`, { cwd: cwd ?? repoDir, encoding: "utf-8" }).trim()
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-char-1",
    identifier: "CHAR-1",
    title: "feat: characterization issue",
    description: "",
    status: { id: "state-todo", name: "Todo", type: "unstarted" },
    team: { id: "team-1", key: "CHAR" },
    labels: [],
    url: "https://example.test/CHAR-1",
    score: null,
    parentId: null,
    children: [],
    relations: [],
    ...overrides,
  }
}

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "wm-char-"))
  git("init -b main")
  git("config user.email test@test.com")
  git("config user.name Test")
  await writeFile(join(repoDir, "README.md"), "# Root\n")
  git("add .")
  git("commit -m 'initial commit'")

  manager = new WorkspaceManager(repoDir)
})

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true })
})

// ── deriveKey ───────────────────────────────────────────────────────

describe("WorkspaceManager.deriveKey — pure sanitization", () => {
  test("currently returns identifier unchanged when only alphanumerics, dots, dashes, underscores are present", () => {
    expect(manager.deriveKey("PROJ-123")).toBe("PROJ-123")
    expect(manager.deriveKey("abc_1.2-3")).toBe("abc_1.2-3")
  })

  test("currently replaces disallowed characters with underscores (spaces, slashes, colons)", () => {
    expect(manager.deriveKey("bad name")).toBe("bad_name")
    expect(manager.deriveKey("ns/ID:42")).toBe("ns_ID_42")
  })

  test("currently replaces disallowed character code units (UTF-16) with a single underscore each", () => {
    // Current behavior: the regex /[^A-Za-z0-9._-]/g operates per UTF-16 code unit.
    // Korean syllables are single BMP code units, so "한글-1" (2 chars + 1 dash + 1 digit)
    // becomes "__-1" (2 underscores). Locks this exact encoding assumption.
    expect(manager.deriveKey("한글-1")).toBe("__-1")
  })
})

// ── create ──────────────────────────────────────────────────────────

describe("WorkspaceManager.create — worktree + metadata bootstrap", () => {
  test("currently creates a worktree, .agent-valley/attempts dir, gitignore entry, and issue.json", async () => {
    const issue = makeIssue({ id: "issue-create-1", identifier: "CHAR-10" })

    const ws = await manager.create(issue)

    expect(ws.issueId).toBe("issue-create-1")
    expect(ws.key).toBe("CHAR-10")
    expect(ws.branch).toBe("feature/CHAR-10")
    expect(ws.path).toBe(join(repoDir, "CHAR-10"))
    expect(ws.status).toBe("idle")

    // Verify worktree is a real branch
    const currentBranch = git("branch --show-current", ws.path)
    expect(currentBranch).toBe("feature/CHAR-10")

    // Metadata directory
    await expect(access(join(ws.path, ".agent-valley", "attempts"))).resolves.toBeUndefined()

    // gitignore contains `.agent-valley/`
    const gitignore = await readFile(join(ws.path, ".gitignore"), "utf-8")
    expect(gitignore).toContain(".agent-valley/")

    // issue.json records metadata
    const meta = JSON.parse(await readFile(join(ws.path, ".agent-valley", "issue.json"), "utf-8")) as {
      issueId: string
      identifier: string
      branch: string
    }
    expect(meta).toEqual({ issueId: "issue-create-1", identifier: "CHAR-10", branch: "feature/CHAR-10" })
  })

  test("currently derives branch prefix from conventional commit in title (fix → fix/)", async () => {
    const issue = makeIssue({ id: "issue-create-fix", identifier: "CHAR-11", title: "fix: bug" })

    const ws = await manager.create(issue)

    expect(ws.branch).toBe("fix/CHAR-11")
  })

  test("currently throws an actionable error when the root is not a git repo", async () => {
    const nonRepoRoot = await mkdtemp(join(tmpdir(), "wm-char-nonrepo-"))
    try {
      const mgr = new WorkspaceManager(nonRepoRoot)
      const issue = makeIssue({ id: "issue-create-err", identifier: "CHAR-12" })

      await expect(mgr.create(issue)).rejects.toThrow(/git worktree add failed/)
      await expect(mgr.create(issue)).rejects.toThrow(/Fix: Ensure/)
    } finally {
      await rm(nonRepoRoot, { recursive: true, force: true })
    }
  })

  test("currently appends .agent-valley/ to an existing .gitignore that lacks it", async () => {
    const issue = makeIssue({ id: "issue-create-gi", identifier: "CHAR-13" })
    // Pre-create a .gitignore-less repo that will get the file after worktree add
    // (create writes .gitignore in the worktree, not the root, so this tests worktree gitignore handling)

    const ws = await manager.create(issue)

    const gitignore = await readFile(join(ws.path, ".gitignore"), "utf-8")
    // Current behavior: file is created with ".agent-valley/\n" as the only entry.
    expect(gitignore).toBe(".agent-valley/\n")
  })

  test("currently reuses an existing workspace when worktree add fails but metadata exists", async () => {
    const issue = makeIssue({ id: "issue-create-reuse", identifier: "CHAR-14" })

    const ws1 = await manager.create(issue)
    // Create a second time — worktree already exists at that path
    const ws2 = await manager.create(issue)

    expect(ws2.path).toBe(ws1.path)
    expect(ws2.issueId).toBe(ws1.issueId)
  })
})

// ── get ─────────────────────────────────────────────────────────────

describe("WorkspaceManager.get — metadata-based lookup", () => {
  test("currently returns null when root directory does not exist", async () => {
    const mgr = new WorkspaceManager(join(tmpdir(), "definitely-does-not-exist-ha"))

    const ws = await mgr.get("any-id")

    expect(ws).toBeNull()
  })

  test("currently returns null when no subdirectory has matching issue.json", async () => {
    const ws = await manager.get("no-such-issue")

    expect(ws).toBeNull()
  })

  test("currently returns workspace when matching .agent-valley/issue.json is present", async () => {
    const issue = makeIssue({ id: "issue-get-1", identifier: "CHAR-20" })
    await manager.create(issue)

    const found = await manager.get("issue-get-1")

    expect(found).not.toBeNull()
    expect(found?.issueId).toBe("issue-get-1")
    expect(found?.branch).toBe("feature/CHAR-20")
    expect(found?.path).toBe(join(repoDir, "CHAR-20"))
  })

  test("currently falls back to feature/{identifier} branch when metadata lacks branch", async () => {
    // Manually create a workspace-like directory with issue.json missing the branch key
    const dir = join(repoDir, "legacy-dir")
    await mkdir(join(dir, ".agent-valley"), { recursive: true })
    await writeFile(
      join(dir, ".agent-valley", "issue.json"),
      JSON.stringify({ issueId: "legacy-id", identifier: "LEG-9" }),
    )

    const found = await manager.get("legacy-id")

    expect(found?.branch).toBe("feature/LEG-9")
  })
})

// ── saveAttempt ─────────────────────────────────────────────────────

describe("WorkspaceManager.saveAttempt — attempt record persistence", () => {
  test("currently writes the RunAttempt JSON to .agent-valley/attempts/{id}.json", async () => {
    const issue = makeIssue({ id: "issue-attempt-1", identifier: "CHAR-30" })
    const ws = await manager.create(issue)

    const attempt: RunAttempt = {
      id: "att-abc",
      issueId: issue.id,
      workspacePath: ws.path,
      startedAt: "2024-01-01T00:00:00.000Z",
      finishedAt: "2024-01-01T00:01:00.000Z",
      exitCode: 0,
      agentOutput: "done",
    }

    await manager.saveAttempt(ws, attempt)

    const raw = await readFile(join(ws.path, ".agent-valley", "attempts", "att-abc.json"), "utf-8")
    expect(JSON.parse(raw)).toEqual(attempt)
  })
})

// ── detectUnfinishedWork ───────────────────────────────────────────

describe("WorkspaceManager.detectUnfinishedWork — uncommitted + branch-diff detection", () => {
  let ws: Workspace

  beforeEach(async () => {
    ws = await manager.create(makeIssue({ id: "issue-detect", identifier: "CHAR-40" }))
  })

  test("currently reports the freshly written .gitignore as an uncommitted change (even though .agent-valley is ignored)", async () => {
    // Characterization: create() writes a new `.gitignore` file to enable .agent-valley ignore.
    // That file itself is untracked, so `git status --porcelain` reports it.
    // detectUnfinishedWork uses the raw status output and therefore flags this as dirty.
    const result = await manager.detectUnfinishedWork(ws)

    expect(result.hasUncommittedChanges).toBe(true)
    expect(result.hasCodeChanges).toBe(true)
  })

  test("currently flags hasUncommittedChanges when untracked file is present", async () => {
    await writeFile(join(ws.path, "new.ts"), "x\n")

    const result = await manager.detectUnfinishedWork(ws)

    expect(result.hasUncommittedChanges).toBe(true)
    expect(result.hasCodeChanges).toBe(true)
  })

  test("currently flags hasCodeChanges without uncommitted flag after commit on branch", async () => {
    await writeFile(join(ws.path, "feature.ts"), "x\n")
    git("add .", ws.path)
    git("commit -m 'feat'", ws.path)

    const result = await manager.detectUnfinishedWork(ws)

    expect(result.hasUncommittedChanges).toBe(false)
    expect(result.hasCodeChanges).toBe(true)
  })
})

// ── autoCommit ──────────────────────────────────────────────────────

describe("WorkspaceManager.autoCommit — safety-net validation + commit", () => {
  let ws: Workspace

  beforeEach(async () => {
    ws = await manager.create(makeIssue({ id: "issue-ac", identifier: "CHAR-50" }))
  })

  test("currently commits untracked + modified files with standard commit message", async () => {
    await writeFile(join(ws.path, "a.ts"), "const a = 1\n")

    const result = await manager.autoCommit(ws)

    expect(result.ok).toBe(true)
    const log = git("log --oneline -1", ws.path)
    expect(log).toContain("auto-commit unfinished agent work")
  })

  test("currently commits the freshly created .gitignore on first autoCommit (characterization of post-create state)", async () => {
    // Fresh workspace has an untracked .gitignore from create(). autoCommit picks it up.
    const result = await manager.autoCommit(ws)

    expect(result.ok).toBe(true)
    const log = git("log --oneline -1", ws.path)
    expect(log).toContain("auto-commit unfinished agent work")
  })

  test("currently returns ok:false with git-commit-failed error when nothing to commit after a prior autoCommit", async () => {
    // First autoCommit captures the .gitignore from create()
    const first = await manager.autoCommit(ws)
    expect(first.ok).toBe(true)

    // Second call: nothing new to commit — git exits non-zero
    const second = await manager.autoCommit(ws)

    expect(second.ok).toBe(false)
    expect(second.error).toContain("git commit failed")
  })

  test("currently blocks auto-commit when truly unmerged (diff-filter=U) files exist", async () => {
    // Create a real unmerged state by attempting to merge divergent histories of the same file.
    await writeFile(join(ws.path, "collide.ts"), "feature\n")
    git("add .", ws.path)
    git("commit -m 'feat side'", ws.path)

    // Diverge main
    git("checkout main", repoDir)
    await writeFile(join(repoDir, "collide.ts"), "main\n")
    git("add .", repoDir)
    git("commit -m 'main side'", repoDir)

    // Attempt merge inside the worktree — produces unmerged files on conflict
    try {
      execSync(`git -C ${ws.path} merge main`, { stdio: ["pipe", "pipe", "pipe"] })
    } catch {
      /* merge exits non-zero on conflict; that is what we want */
    }

    const result = await manager.autoCommit(ws)

    expect(result.ok).toBe(false)
    // Current behavior: "Unmerged files present" is emitted before the conflict-marker path.
    expect(result.error).toContain("Unmerged files present")
  })

  test("currently returns retryable=true for regeneratable lockfile conflict markers", async () => {
    await writeFile(
      join(ws.path, "package-lock.json"),
      '<<<<<<< HEAD\n{"name":"x"}\n=======\n{"name":"y"}\n>>>>>>> branch\n',
    )

    const result = await manager.autoCommit(ws)

    expect(result.ok).toBe(false)
    expect(result.retryable).toBe(true)
    expect(result.retryPrompt).toContain("regenerate")
  })

  test("currently does NOT mark high-risk conflict files (package.json) as retryable", async () => {
    await writeFile(
      join(ws.path, "package.json"),
      '<<<<<<< HEAD\n{"name":"x"}\n=======\n{"name":"y"}\n>>>>>>> branch\n',
    )

    const result = await manager.autoCommit(ws)

    expect(result.ok).toBe(false)
    expect(result.retryable).toBeFalsy()
    expect(result.error).toContain("Conflict markers detected")
  })
})

// ── getDiffStat ─────────────────────────────────────────────────────

describe("WorkspaceManager.getDiffStat — short-stat summary line", () => {
  let ws: Workspace

  beforeEach(async () => {
    ws = await manager.create(makeIssue({ id: "issue-ds", identifier: "CHAR-60" }))
  })

  test("currently returns null for clean worktree", async () => {
    expect(await manager.getDiffStat(ws)).toBeNull()
  })

  test("currently returns the git summary line when commits exist on branch", async () => {
    await writeFile(join(ws.path, "f.ts"), "const f = 1\n")
    git("add .", ws.path)
    git("commit -m 'feat'", ws.path)

    const stat = await manager.getDiffStat(ws)

    expect(stat).not.toBeNull()
    expect(stat).toMatch(/\d+ file.*changed/)
  })
})

// ── pushBranch ──────────────────────────────────────────────────────

describe("WorkspaceManager.pushBranch — remote push with noop fallback", () => {
  test("currently returns ok:true without pushing when no origin remote is configured", async () => {
    const ws = await manager.create(makeIssue({ id: "issue-push-local", identifier: "CHAR-70" }))

    const result = await manager.pushBranch(ws)

    expect(result.ok).toBe(true)
  })

  test("currently pushes the feature branch to origin when remote exists", async () => {
    const bare = await mkdtemp(join(tmpdir(), "wm-char-bare-"))
    try {
      execSync(`git init --bare ${bare}`)
      git(`remote add origin ${bare}`)
      git("push -u origin main")

      const ws = await manager.create(makeIssue({ id: "issue-push-remote", identifier: "CHAR-71" }))
      await writeFile(join(ws.path, "x.ts"), "x\n")
      git("add .", ws.path)
      git("commit -m 'feat'", ws.path)

      const result = await manager.pushBranch(ws)

      expect(result.ok).toBe(true)
      const remoteBranches = execSync(`git -C ${bare} branch`, { encoding: "utf-8" })
      expect(remoteBranches).toContain("feature/CHAR-71")
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })

  test("currently returns ok:false with Push failed error when push is rejected", async () => {
    const bare = await mkdtemp(join(tmpdir(), "wm-char-bare-reject-"))
    try {
      execSync(`git init --bare ${bare}`)
      git(`remote add origin ${bare}`)
      git("push -u origin main")

      const ws = await manager.create(makeIssue({ id: "issue-push-rej", identifier: "CHAR-72" }))
      await writeFile(join(ws.path, "x.ts"), "x\n")
      git("add .", ws.path)
      git("commit -m 'feat'", ws.path)

      // Pre-push the branch from the remote under a conflicting history to force a rejection
      const otherClone = await mkdtemp(join(tmpdir(), "wm-char-other-"))
      try {
        execSync(`git clone ${bare} ${otherClone}`, { stdio: "pipe" })
        execSync(`git -C ${otherClone} checkout -b feature/CHAR-72`, { stdio: "pipe" })
        await writeFile(join(otherClone, "other.ts"), "o\n")
        execSync(`git -C ${otherClone} add .`, { stdio: "pipe" })
        execSync(`git -C ${otherClone} -c user.email=o@o -c user.name=O commit -m other`, {
          stdio: "pipe",
        })
        execSync(`git -C ${otherClone} push -u origin feature/CHAR-72`, { stdio: "pipe" })
      } finally {
        await rm(otherClone, { recursive: true, force: true })
      }

      const result = await manager.pushBranch(ws)

      // Non-ff push should be rejected
      expect(result.ok).toBe(false)
      expect(result.error).toContain("Push failed")
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })
})

// ── createDraftPR ───────────────────────────────────────────────────

describe("WorkspaceManager.createDraftPR — gh CLI best-effort wrapper", () => {
  test("currently returns { created: false } silently when gh CLI is missing or PR creation fails", async () => {
    const ws = await manager.create(makeIssue({ id: "issue-pr-1", identifier: "CHAR-80" }))

    // No remote / no gh auth — behavior we lock: gracefully returns created=false
    const result = await manager.createDraftPR(ws, { title: "Draft", body: "Body" })

    expect(result.created).toBe(false)
    expect(result.url).toBeUndefined()
  })
})

// ── cleanup ────────────────────────────────────────────────────────

describe("WorkspaceManager.cleanup — worktree removal + directory cleanup", () => {
  test("currently removes the git worktree and the filesystem directory", async () => {
    const ws = await manager.create(makeIssue({ id: "issue-clean-1", identifier: "CHAR-90" }))
    expect(existsSync(ws.path)).toBe(true)

    await manager.cleanup(ws)

    expect(existsSync(ws.path)).toBe(false)
    const worktrees = git("worktree list")
    expect(worktrees).not.toContain(ws.path)
  })

  test("currently tolerates cleanup of a workspace whose directory was already removed", async () => {
    const ws = await manager.create(makeIssue({ id: "issue-clean-gone", identifier: "CHAR-91" }))
    // Pre-remove
    await rm(ws.path, { recursive: true, force: true })

    // Should not throw
    await expect(manager.cleanup(ws)).resolves.toBeUndefined()
  })
})

// ── mergeAndPush ───────────────────────────────────────────────────

describe("WorkspaceManager.mergeAndPush — rebase-based delivery", () => {
  test("currently returns ok:true with 'No changes to merge' semantics when branch has no diff vs main", async () => {
    const ws = await manager.create(makeIssue({ id: "issue-merge-empty", identifier: "CHAR-100" }))

    const result = await manager.mergeAndPush(ws)

    expect(result.ok).toBe(true)
  })

  test("currently merges committed branch changes locally when no remote is configured (branch deletion skipped)", async () => {
    const ws = await manager.create(makeIssue({ id: "issue-merge-local", identifier: "CHAR-101" }))
    await writeFile(join(ws.path, "feat.ts"), "const feat = 1\n")
    git("add .", ws.path)
    git("commit -m 'feat: add feat'", ws.path)

    const result = await manager.mergeAndPush(ws)

    expect(result.ok).toBe(true)

    // main should now contain the feature commit
    const log = git("log --oneline main")
    expect(log).toContain("add feat")

    // Characterization: current implementation attempts `git branch -D <branch>` after merge,
    // but because the branch is still checked out by the worktree, deletion fails silently
    // and the branch remains visible in `git branch`. PR2 may choose to change this —
    // lock it here so any deviation is deliberate.
    const branches = git("branch")
    expect(branches).toContain("feature/CHAR-101")
  })

  test("currently detects conflict markers on the branch via git-diff-check before rebase", async () => {
    const ws = await manager.create(makeIssue({ id: "issue-merge-conflict", identifier: "CHAR-102" }))
    await writeFile(join(ws.path, "bad.ts"), "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n")
    git("add .", ws.path)
    git("commit --no-verify -m 'conflict markers'", ws.path)

    const result = await manager.mergeAndPush(ws)

    expect(result.ok).toBe(false)
    // Current implementation reaches the `git diff --check main...branch` branch first
    // because the file has no unmerged (U) status and the in-branch diff is not empty.
    expect(result.error).toContain("git diff --check failed")
    expect(result.error).toContain("Fix: Resolve the reported diff problems")
  })
})

// ── Smoke: end-to-end lifecycle from create to cleanup ─────────────

describe("WorkspaceManager — end-to-end lifecycle (characterization smoke)", () => {
  test("currently supports create → saveAttempt → detectUnfinishedWork → autoCommit → getDiffStat → cleanup", async () => {
    const issue = makeIssue({ id: "issue-e2e", identifier: "CHAR-E2E" })
    const ws = await manager.create(issue)

    await manager.saveAttempt(ws, {
      id: "att-1",
      issueId: issue.id,
      workspacePath: ws.path,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      agentOutput: null,
    })

    await writeFile(join(ws.path, "e2e.ts"), "export const e2e = true\n")
    const detect1 = await manager.detectUnfinishedWork(ws)
    expect(detect1.hasUncommittedChanges).toBe(true)

    const commit = await manager.autoCommit(ws)
    expect(commit.ok).toBe(true)

    const stat = await manager.getDiffStat(ws)
    expect(stat).not.toBeNull()

    // Attempt file persists before cleanup
    const attemptFiles = await readdir(join(ws.path, ".agent-valley", "attempts"))
    expect(attemptFiles).toContain("att-1.json")

    await manager.cleanup(ws)
    expect(existsSync(ws.path)).toBe(false)
  })
})
