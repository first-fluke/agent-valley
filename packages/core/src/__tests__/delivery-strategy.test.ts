/**
 * Unit tests — delivery-strategy module.
 *
 * `runCommand` (spawn-based git / gh wrapper) is mocked so we can assert
 * branching behavior deterministically without touching real git. The
 * end-to-end delivery behavior is already locked by `merge-conflict.test.ts`
 * and the characterization suite.
 *
 * PR2 split: docs/plans/v0-2-bigbang-design.md § 5.4
 */

import { beforeEach, describe, expect, test, vi } from "vitest"
import type { Workspace } from "../domain/models"

type CommandResult = { exitCode: number; stdout: string; stderr: string }
type Call = { cmd: string; args: string[] }

// Queue-based mock: each call pops the head of `responses`, or returns a default.
const calls: Call[] = []
const responses: CommandResult[] = []
const defaultSuccess: CommandResult = { exitCode: 0, stdout: "", stderr: "" }

vi.mock("../workspace/worktree-lifecycle", async () => {
  const actual = await vi.importActual<typeof import("../workspace/worktree-lifecycle")>(
    "../workspace/worktree-lifecycle",
  )
  return {
    ...actual,
    runCommand: vi.fn(async (cmd: string, args: string[]) => {
      calls.push({ cmd, args })
      return responses.shift() ?? defaultSuccess
    }),
  }
})

// Import after `vi.mock` so the mocked `runCommand` is bound.
const { createDraftPR, mergeAndPush, pushBranch } = await import("../workspace/delivery-strategy")

function enqueue(...results: CommandResult[]): void {
  responses.push(...results)
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    issueId: "issue-d",
    path: "/tmp/root/DS-1",
    key: "DS-1",
    branch: "feature/DS-1",
    status: "running",
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  }
}

beforeEach(() => {
  calls.length = 0
  responses.length = 0
})

describe("mergeAndPush — verification gate guard", () => {
  test("refuses to run any git command when opts.verified is false", async () => {
    const result = await mergeAndPush(makeWorkspace(), "/tmp/root", { verified: false })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("verified:false")
    expect(calls).toHaveLength(0)
  })

  test("proceeds normally when opts.verified is omitted (backward compatible)", async () => {
    enqueue(
      { exitCode: 1, stdout: "", stderr: "" }, // no remote
      { exitCode: 0, stdout: "", stderr: "" }, // diff --quiet → no diff
    )

    const result = await mergeAndPush(makeWorkspace(), "/tmp/root")

    expect(result.ok).toBe(true)
    expect(calls.length).toBeGreaterThan(0)
  })

  test("proceeds normally when opts.verified is explicitly true", async () => {
    enqueue(
      { exitCode: 1, stdout: "", stderr: "" }, // no remote
      { exitCode: 0, stdout: "", stderr: "" }, // diff --quiet → no diff
    )

    const result = await mergeAndPush(makeWorkspace(), "/tmp/root", { verified: true })

    expect(result.ok).toBe(true)
  })
})

describe("mergeAndPush", () => {
  test("short-circuits with ok:true when branch has no diff vs main", async () => {
    enqueue(
      { exitCode: 0, stdout: "origin\n", stderr: "" }, // remote get-url origin
      { exitCode: 0, stdout: "", stderr: "" }, // checkout main
      { exitCode: 0, stdout: "", stderr: "" }, // pull --ff-only
      { exitCode: 0, stdout: "", stderr: "" }, // diff --quiet main...branch → 0 = no diff
    )

    const result = await mergeAndPush(makeWorkspace(), "/tmp/root")

    expect(result.ok).toBe(true)
    expect(calls.map((c) => c.args[0])).toContain("remote")
  })

  test("returns ok:true when branch has no diff (no remote path)", async () => {
    enqueue(
      { exitCode: 1, stdout: "", stderr: "" }, // no remote
      { exitCode: 0, stdout: "", stderr: "" }, // diff --quiet → no diff
    )

    const result = await mergeAndPush(makeWorkspace(), "/tmp/root")

    expect(result.ok).toBe(true)
  })

  test("rebases then fast-forward-merges when pre/post validation succeeds (no remote)", async () => {
    enqueue(
      { exitCode: 1, stdout: "", stderr: "" }, // no remote
      { exitCode: 1, stdout: "", stderr: "" }, // diff --quiet → branch has diff
      // preRebase validateBranchBeforeMerge
      { exitCode: 0, stdout: "", stderr: "" }, // diff --name-only --diff-filter=U
      { exitCode: 0, stdout: "", stderr: "" }, // diff --name-only main...branch
      { exitCode: 0, stdout: "", stderr: "" }, // diff --check main...branch
      // rebase main branch
      { exitCode: 0, stdout: "", stderr: "" },
      // postRebase validateBranchBeforeMerge
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      // checkout main + ff-only merge
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      // branch -D
      { exitCode: 0, stdout: "", stderr: "" },
    )

    const result = await mergeAndPush(makeWorkspace(), "/tmp/root")

    expect(result.ok).toBe(true)
    const rebaseInvoked = calls.some((c) => c.cmd === "git" && c.args[0] === "rebase" && c.args.includes("main"))
    expect(rebaseInvoked).toBe(true)
    const ffMergeInvoked = calls.some((c) => c.cmd === "git" && c.args[0] === "merge" && c.args.includes("--ff-only"))
    expect(ffMergeInvoked).toBe(true)
  })

  test("returns error with actionable fix when branch has unmerged files pre-rebase", async () => {
    enqueue(
      { exitCode: 1, stdout: "", stderr: "" }, // no remote
      { exitCode: 1, stdout: "", stderr: "" }, // diff --quiet → branch has diff
      // preRebase validateBranchBeforeMerge — unmerged files present
      { exitCode: 0, stdout: "conflict.ts\n", stderr: "" }, // diff --name-only --diff-filter=U
    )

    const result = await mergeAndPush(makeWorkspace(), "/tmp/root")

    expect(result.ok).toBe(false)
    expect(result.error).toContain("Unmerged files present")
    expect(result.error).toContain("Fix:")
  })
})

describe("mergeAndPush — rebase conflict classification (no destructive auto-resolution)", () => {
  function enqueuePreRebaseHappyPath(): void {
    enqueue(
      { exitCode: 1, stdout: "", stderr: "" }, // no remote
      { exitCode: 1, stdout: "", stderr: "" }, // diff --quiet → branch has diff
      { exitCode: 0, stdout: "", stderr: "" }, // preRebase: diff --name-only --diff-filter=U (clean)
      { exitCode: 0, stdout: "", stderr: "" }, // preRebase: diff --name-only main...branch (no changed files → skip marker scan)
      { exitCode: 0, stdout: "", stderr: "" }, // preRebase: diff --check main...branch
      { exitCode: 1, stdout: "", stderr: "conflict" }, // rebase main branch → fails
      { exitCode: 1, stdout: "", stderr: "" }, // diff --check → still has conflict markers
    )
  }

  test("ordinary (non-lockfile, non-high-risk) conflict never runs checkout --theirs and returns retryable", async () => {
    enqueuePreRebaseHappyPath()
    enqueue(
      { exitCode: 0, stdout: "src/models.ts\n", stderr: "" }, // autoResolveRebaseConflicts: diff --name-only --diff-filter=U
      { exitCode: 0, stdout: "", stderr: "" }, // rebase --abort
    )

    const result = await mergeAndPush(makeWorkspace(), "/tmp/root")

    expect(result.ok).toBe(false)
    expect(result.retryable).toBe(true)
    expect(result.error).toContain("src/models.ts")
    expect(result.retryPrompt).toContain("preserving BOTH main's changes and your own")

    const theirsCall = calls.find((c) => c.cmd === "git" && c.args.includes("--theirs"))
    expect(theirsCall).toBeUndefined()
    const abortCall = calls.find((c) => c.cmd === "git" && c.args[0] === "rebase" && c.args.includes("--abort"))
    expect(abortCall).toBeDefined()
  })

  test("conflict confined to regeneratable lockfiles returns the lockfile retry prompt", async () => {
    enqueuePreRebaseHappyPath()
    enqueue(
      { exitCode: 0, stdout: "package-lock.json\n", stderr: "" }, // diff --name-only --diff-filter=U
      { exitCode: 0, stdout: "", stderr: "" }, // rebase --abort
    )

    const result = await mergeAndPush(makeWorkspace(), "/tmp/root")

    expect(result.ok).toBe(false)
    expect(result.retryable).toBe(true)
    expect(result.error).toContain("regeneratable lockfiles")
    expect(result.retryPrompt).toContain("dependency install or sync")

    const theirsCall = calls.find((c) => c.cmd === "git" && c.args.includes("--theirs"))
    expect(theirsCall).toBeUndefined()
  })

  test("conflict touching a high-risk file (e.g. migrations) hard-fails without retryable", async () => {
    enqueuePreRebaseHappyPath()
    enqueue(
      { exitCode: 0, stdout: "db/migrations/001_init.sql\n", stderr: "" }, // diff --name-only --diff-filter=U
      { exitCode: 0, stdout: "", stderr: "" }, // rebase --abort
    )

    const result = await mergeAndPush(makeWorkspace(), "/tmp/root")

    expect(result.ok).toBe(false)
    expect(result.retryable).toBeFalsy()
    expect(result.error).toContain("high-risk file")
    expect(result.error).toContain("db/migrations/001_init.sql")

    const theirsCall = calls.find((c) => c.cmd === "git" && c.args.includes("--theirs"))
    expect(theirsCall).toBeUndefined()
  })

  test("mixed lockfile + ordinary conflict is treated as ordinary (retryable, no destructive resolution)", async () => {
    enqueuePreRebaseHappyPath()
    enqueue(
      { exitCode: 0, stdout: "package-lock.json\nsrc/models.ts\n", stderr: "" }, // diff --name-only --diff-filter=U
      { exitCode: 0, stdout: "", stderr: "" }, // rebase --abort
    )

    const result = await mergeAndPush(makeWorkspace(), "/tmp/root")

    expect(result.ok).toBe(false)
    expect(result.retryable).toBe(true)
    expect(result.retryPrompt).toContain("package-lock.json")
    expect(result.retryPrompt).toContain("src/models.ts")
    expect(result.retryPrompt).toContain("Regenerate the lockfile(s)")

    const theirsCall = calls.find((c) => c.cmd === "git" && c.args.includes("--theirs"))
    expect(theirsCall).toBeUndefined()
  })
})

describe("pushBranch", () => {
  test("returns ok:true silently when no remote is configured", async () => {
    enqueue({ exitCode: 1, stdout: "", stderr: "" })

    const result = await pushBranch(makeWorkspace(), "/tmp/root")

    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual(["remote", "get-url", "origin"])
  })

  test("invokes git push -u origin <branch> when remote exists", async () => {
    enqueue(
      { exitCode: 0, stdout: "origin-url", stderr: "" }, // remote get-url
      { exitCode: 0, stdout: "", stderr: "" }, // push
    )

    const result = await pushBranch(makeWorkspace({ branch: "feature/DS-P" }), "/tmp/root")

    expect(result.ok).toBe(true)
    const pushCall = calls.find((c) => c.args[0] === "push")
    expect(pushCall?.args).toEqual(["push", "-u", "origin", "feature/DS-P"])
  })

  test("surfaces push failures with an actionable error", async () => {
    enqueue(
      { exitCode: 0, stdout: "origin-url", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "rejected: non-fast-forward" },
    )

    const result = await pushBranch(makeWorkspace(), "/tmp/root")

    expect(result.ok).toBe(false)
    expect(result.error).toContain("Push failed")
    expect(result.error).toContain("rejected: non-fast-forward")
  })
})

describe("createDraftPR", () => {
  test("returns { created: false } silently when gh fails (no remote / no auth)", async () => {
    enqueue(
      { exitCode: 0, stdout: "[]", stderr: "" }, // gh pr list — none
      { exitCode: 1, stdout: "", stderr: "no git remotes found" }, // gh pr create
    )

    const result = await createDraftPR(makeWorkspace(), "/tmp/root", { title: "t", body: "b" })

    expect(result.created).toBe(false)
    expect(result.url).toBeUndefined()
  })

  test("returns existing PR URL when gh pr list already reports one", async () => {
    enqueue({ exitCode: 0, stdout: '[{"url":"https://example.test/pr/7"}]', stderr: "" })

    const result = await createDraftPR(makeWorkspace(), "/tmp/root", { title: "t", body: "b" })

    expect(result.created).toBe(false)
    expect(result.url).toBe("https://example.test/pr/7")
  })

  test("creates a draft PR and returns the URL on success", async () => {
    enqueue(
      { exitCode: 0, stdout: "[]", stderr: "" }, // gh pr list — none
      { exitCode: 0, stdout: "https://example.test/pr/42\n", stderr: "" }, // gh pr create
    )

    const result = await createDraftPR(makeWorkspace(), "/tmp/root", { title: "t", body: "b" })

    expect(result.created).toBe(true)
    expect(result.url).toBe("https://example.test/pr/42")
  })
})
