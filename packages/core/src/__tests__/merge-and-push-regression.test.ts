import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import type { Issue, Workspace } from "../domain/models"
import { mergeAndPush } from "../workspace/delivery-strategy"
import { createWorkspace } from "../workspace/worktree-lifecycle"

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout.trim()
}

async function fixture(withOrigin = false): Promise<{
  dir: string
  root: string
  origin: string
  workspace: Workspace
}> {
  const dir = mkdtempSync(join(tmpdir(), "av-delivery-regression-"))
  const root = join(dir, "repo")
  const origin = join(dir, "origin.git")
  mkdirSync(root)
  git(root, "init", "-qb", "trunk")
  git(root, "config", "user.name", "Test")
  git(root, "config", "user.email", "test@example.invalid")
  writeFileSync(join(root, "base.txt"), "base\n")
  git(root, "add", "base.txt")
  git(root, "commit", "-qm", "base")
  if (withOrigin) {
    mkdirSync(origin)
    git(origin, "init", "--bare", "-qb", "trunk")
    git(root, "remote", "add", "origin", origin)
    git(root, "push", "-q", "-u", "origin", "trunk")
    git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")
  }
  const workspace = await createWorkspace(
    root,
    { id: "issue", identifier: "ISSUE-1", title: "feat: delivery" } as Issue,
    "darwin",
  )
  writeFileSync(join(workspace.path, "feature.txt"), "feature\n")
  git(workspace.path, "add", "feature.txt")
  git(workspace.path, "commit", "-qm", "feature")
  return { dir, root, origin, workspace }
}

describe("mergeAndPush local Git regressions", () => {
  test("fails closed when source HEAD is the issue branch and other bases are ambiguous", async () => {
    const dir = mkdtempSync(join(tmpdir(), "av-delivery-no-base-"))
    try {
      git(dir, "init", "-qb", "trunk")
      git(dir, "config", "user.name", "Test")
      git(dir, "config", "user.email", "test@example.invalid")
      writeFileSync(join(dir, "base.txt"), "base\n")
      git(dir, "add", "base.txt")
      git(dir, "commit", "-qm", "base")
      git(dir, "branch", "feature/OTHER")
      git(dir, "checkout", "-qb", "feature/ISSUE-1")
      writeFileSync(join(dir, "feature.txt"), "feature\n")
      git(dir, "add", "feature.txt")
      git(dir, "commit", "-qm", "feature")

      const workspace = { path: join(dir, "missing-worktree"), branch: "feature/ISSUE-1" } as Workspace
      const result = await mergeAndPush(workspace, dir)
      expect(result.ok).toBe(false)
      expect(result.error).toContain("Could not identify the repository base branch")
      expect(git(dir, "branch", "--show-current")).toBe("feature/ISSUE-1")
      expect(git(dir, "show", "trunk:base.txt")).toBe("base")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("does not deliver an issue into another checked-out feature branch", async () => {
    const f = await fixture()
    try {
      git(f.root, "checkout", "-qb", "feature/OTHER")
      const trunkBefore = git(f.root, "rev-parse", "trunk")
      const otherBefore = git(f.root, "rev-parse", "feature/OTHER")
      const issueBefore = git(f.root, "rev-parse", f.workspace.branch)

      const result = await mergeAndPush(f.workspace, f.root)
      expect(result.ok).toBe(false)
      expect(result.error).toContain("agent-valley.baseBranch")
      expect(git(f.root, "branch", "--show-current")).toBe("feature/OTHER")
      expect(git(f.root, "rev-parse", "trunk")).toBe(trunkBefore)
      expect(git(f.root, "rev-parse", "feature/OTHER")).toBe(otherBefore)
      expect(git(f.root, "rev-parse", f.workspace.branch)).toBe(issueBefore)
      expect(() => git(f.root, "show", "feature/OTHER:feature.txt")).toThrow()
    } finally {
      rmSync(f.dir, { recursive: true, force: true })
    }
  })

  test("a repo-local base setting delivers to trunk from an unrelated checkout", async () => {
    const f = await fixture()
    try {
      git(f.root, "checkout", "-qb", "feature/OTHER")
      const otherBefore = git(f.root, "rev-parse", "feature/OTHER")
      git(f.root, "config", "--local", "agent-valley.baseBranch", "trunk")

      expect((await mergeAndPush(f.workspace, f.root)).ok).toBe(true)
      expect(git(f.root, "show", "trunk:feature.txt")).toBe("feature")
      expect(git(f.root, "rev-parse", "feature/OTHER")).toBe(otherBefore)
    } finally {
      rmSync(f.dir, { recursive: true, force: true })
    }
  })

  test("delivers to trunk without origin and leaves a checked-out worktree branch for cleanup", async () => {
    const f = await fixture()
    try {
      expect((await mergeAndPush(f.workspace, f.root)).ok).toBe(true)
      expect(git(f.root, "show", "trunk:feature.txt")).toBe("feature")
      expect(git(f.workspace.path, "branch", "--show-current")).toBe(f.workspace.branch)
    } finally {
      rmSync(f.dir, { recursive: true, force: true })
    }
  })

  test("pushes an integrated trunk commit to a local bare origin", async () => {
    const f = await fixture(true)
    try {
      expect((await mergeAndPush(f.workspace, f.root)).ok).toBe(true)
      expect(git(f.origin, "show", "trunk:feature.txt")).toBe("feature")
    } finally {
      rmSync(f.dir, { recursive: true, force: true })
    }
  })

  test("failed checkout keeps dirty source work and reports no delivery", async () => {
    const f = await fixture(true)
    try {
      git(f.root, "checkout", "-qb", "scratch")
      git(f.root, "checkout", "trunk")
      writeFileSync(join(f.root, "base.txt"), "trunk update\n")
      git(f.root, "add", "base.txt")
      git(f.root, "commit", "-qm", "trunk update")
      git(f.root, "checkout", "scratch")
      writeFileSync(join(f.root, "base.txt"), "dirty scratch\n")

      const result = await mergeAndPush(f.workspace, f.root)
      expect(result.ok).toBe(false)
      expect(result.error).toContain("Checkout of trunk")
      expect(git(f.root, "branch", "--show-current")).toBe("scratch")
      expect(readFileSync(join(f.root, "base.txt"), "utf8")).toBe("dirty scratch\n")
      expect(git(f.origin, "show", "trunk:base.txt")).toBe("base")
    } finally {
      rmSync(f.dir, { recursive: true, force: true })
    }
  })

  test("failed fast-forward pull preserves local and remote divergent commits", async () => {
    const f = await fixture(true)
    try {
      const peer = join(f.dir, "peer")
      git(f.dir, "clone", "-q", f.origin, peer)
      git(peer, "config", "user.name", "Peer")
      git(peer, "config", "user.email", "peer@example.invalid")
      writeFileSync(join(peer, "remote.txt"), "remote\n")
      git(peer, "add", "remote.txt")
      git(peer, "commit", "-qm", "remote")
      git(peer, "push", "-q", "origin", "trunk")
      writeFileSync(join(f.root, "local.txt"), "local\n")
      git(f.root, "add", "local.txt")
      git(f.root, "commit", "-qm", "local")

      const result = await mergeAndPush(f.workspace, f.root)
      expect(result.ok).toBe(false)
      expect(result.error).toContain("Update of trunk")
      expect(git(f.root, "show", "trunk:local.txt")).toBe("local")
      expect(git(f.origin, "show", "trunk:remote.txt")).toBe("remote")
    } finally {
      rmSync(f.dir, { recursive: true, force: true })
    }
  })

  test("failed merge conflict never reports success or loses either branch", async () => {
    const f = await fixture()
    try {
      // The feature changes the same file that a checkout hook advances on
      // trunk between a successful rebase and the merge.
      writeFileSync(join(f.workspace.path, "base.txt"), "feature version\n")
      git(f.workspace.path, "add", "base.txt")
      git(f.workspace.path, "commit", "-qm", "feature version")
      const hook = join(f.root, ".git", "hooks", "post-checkout")
      writeFileSync(
        hook,
        "#!/bin/sh\n" +
          'if [ "$(git symbolic-ref --quiet --short HEAD)" = "trunk" ] && [ ! -f .git/review-hook-ran ]; then\n' +
          "  touch .git/review-hook-ran\n" +
          "  printf 'concurrent version\\n' > base.txt\n" +
          "  git add base.txt\n" +
          "  git -c user.name=Test -c user.email=test@example.invalid commit -qm concurrent\n" +
          "fi\n",
      )
      chmodSync(hook, 0o755)

      const result = await mergeAndPush(f.workspace, f.root)
      expect(result.ok).toBe(false)
      expect(result.error).toContain("Merge of")
      expect(git(f.root, "show", "trunk:base.txt")).toBe("concurrent version")
      expect(git(f.root, "show", `${f.workspace.branch}:base.txt`)).toBe("feature version")
    } finally {
      rmSync(f.dir, { recursive: true, force: true })
    }
  })

  test("rejected push keeps local integration for a later safe retry", async () => {
    const f = await fixture(true)
    try {
      const hook = join(f.origin, "hooks", "pre-receive")
      writeFileSync(hook, "#!/bin/sh\nexit 1\n")
      chmodSync(hook, 0o755)
      const first = await mergeAndPush(f.workspace, f.root)
      expect(first.ok).toBe(false)
      expect(first.error).toContain("Push of trunk")
      expect(git(f.root, "show", "trunk:feature.txt")).toBe("feature")
      expect(() => git(f.origin, "show", "trunk:feature.txt")).toThrow()

      rmSync(hook)
      expect((await mergeAndPush(f.workspace, f.root)).ok).toBe(true)
      expect(git(f.origin, "show", "trunk:feature.txt")).toBe("feature")
    } finally {
      rmSync(f.dir, { recursive: true, force: true })
    }
  })
})
