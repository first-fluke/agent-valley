import { describe, expect, it, vi } from "vitest"
import { discoverReleaseCandidate, mergeReleaseCandidate } from "./release-automation.mjs"

const mainSha = "a".repeat(40)
const headSha = "b".repeat(40)
const mergeSha = "c".repeat(40)
const repository = { full_name: "first-fluke/agent-valley" }
const context = { repo: { owner: "first-fluke", repo: "agent-valley" } }
const branch = "release-please--branches--main--components--agent-valley"

function releasePull() {
  return {
    number: 16,
    state: "open",
    merged: false,
    draft: false,
    title: "chore(main): release agent-valley 0.4.0",
    user: { login: "github-actions[bot]", type: "Bot" },
    labels: [{ name: "autorelease: pending" }],
    head: { ref: branch, sha: headSha, repo: { ...repository } },
    base: { ref: "main", sha: mainSha, repo: { ...repository } },
  }
}
type Pull = ReturnType<typeof releasePull>

function fixture() {
  const state = {
    listed: [releasePull()],
    live: releasePull(),
    main: mainSha,
    mergeBase: mainSha,
    headTree: "d".repeat(40),
    mergedTree: "d".repeat(40),
    merge: { merged: true, sha: mergeSha, message: "Pull Request successfully merged" },
  }
  const github = {
    paginate: vi.fn(async () => state.listed),
    rest: {
      pulls: {
        list: vi.fn(),
        get: vi.fn(async () => ({ data: state.live })),
        merge: vi.fn(async () => ({ data: state.merge })),
      },
      git: {
        getRef: vi.fn(async () => ({ data: { object: { sha: state.main } } })),
        getCommit: vi.fn(async ({ commit_sha }: { commit_sha: string }) => ({
          data: { tree: { sha: commit_sha === headSha ? state.headTree : state.mergedTree } },
        })),
      },
      repos: {
        compareCommitsWithBasehead: vi.fn(async () => ({
          data: { base_commit: { sha: mainSha }, merge_base_commit: { sha: state.mergeBase } },
        })),
      },
    },
  }
  return { state, github, context }
}

function verifiedCandidate() {
  return { number: 16, headSha, headBranch: branch, baseSha: mainSha }
}

const disallowedPulls: [string, (pull: Pull) => void][] = [
  ["a human with a spoofed pending label", (pull) => (pull.user.login = "maintainer")],
  ["a username with the wrong account type", (pull) => (pull.user.type = "User")],
  ["a draft release", (pull) => (pull.draft = true)],
  ["a closed release", (pull) => (pull.state = "closed")],
  ["an already merged release", (pull) => (pull.merged = true)],
  ["an unrelated dependency branch", (pull) => (pull.head.ref = "dependabot/npm/update")],
  ["a lookalike release branch", (pull) => (pull.head.ref = `${branch}-spoof`)],
  ["a non-main base", (pull) => (pull.base.ref = "develop")],
  ["a fork branch", (pull) => (pull.head.repo.full_name = "attacker/agent-valley")],
  ["a different base repository", (pull) => (pull.base.repo.full_name = "first-fluke/other")],
  ["a completed release label", (pull) => (pull.labels = [{ name: "autorelease: tagged" }])],
  ["a lookalike release label", (pull) => (pull.labels = [{ name: "autorelease: pending-spoof" }])],
  ["a missing release label", (pull) => (pull.labels = [])],
]

describe("release PR discovery", () => {
  it("finds an unchanged release via paginated API results without action PR outputs", async () => {
    const f = fixture()
    await expect(discoverReleaseCandidate(f)).resolves.toEqual(verifiedCandidate())
    expect(f.github.paginate).toHaveBeenCalledWith(f.github.rest.pulls.list, {
      ...context.repo,
      base: "main",
      state: "open",
      per_page: 100,
    })
    expect(f.github.rest.repos.compareCommitsWithBasehead).toHaveBeenCalledWith({
      ...context.repo,
      basehead: `${mainSha}...${headSha}`,
    })
  })

  it("supports release-please's root branch", async () => {
    const f = fixture()
    f.state.listed[0].head.ref = "release-please--branches--main"
    f.state.live.head.ref = "release-please--branches--main"
    await expect(discoverReleaseCandidate(f)).resolves.toMatchObject({
      headBranch: "release-please--branches--main",
    })
  })

  it("returns null when no release is pending", async () => {
    const f = fixture()
    f.state.listed = []
    await expect(discoverReleaseCandidate(f)).resolves.toBeNull()
    expect(f.github.rest.pulls.get).not.toHaveBeenCalled()
  })

  it.each(disallowedPulls)("ignores %s", async (_name, mutate) => {
    const f = fixture()
    mutate(f.state.listed[0])
    await expect(discoverReleaseCandidate(f)).resolves.toBeNull()
    expect(f.github.rest.pulls.merge).not.toHaveBeenCalled()
  })

  it("rejects duplicate eligible PRs instead of selecting the newest", async () => {
    const f = fixture()
    f.state.listed.push({ ...releasePull(), number: 17 })
    await expect(discoverReleaseCandidate(f)).rejects.toThrow("multiple owned release-please PRs")
    expect(f.github.rest.pulls.get).not.toHaveBeenCalled()
  })

  it("rejects a PR that lost its trusted identity after listing", async () => {
    const f = fixture()
    f.state.live.user.login = "attacker"
    await expect(discoverReleaseCandidate(f)).rejects.toThrow("no longer matches")
  })

  it("uses the live head rather than the stale list response", async () => {
    const f = fixture()
    f.state.live.head.sha = "d".repeat(40)
    await expect(discoverReleaseCandidate(f)).resolves.toMatchObject({ headSha: "d".repeat(40) })
  })

  it("rejects stale ancestry even when compare's base_commit equals main", async () => {
    const f = fixture()
    f.state.mergeBase = "d".repeat(40)
    await expect(discoverReleaseCandidate(f)).rejects.toThrow("does not contain current main")
    expect(f.github.rest.pulls.merge).not.toHaveBeenCalled()
  })

  it.each(["head", "main"])("rejects an abbreviated %s commit", async (kind) => {
    const f = fixture()
    if (kind === "head") f.state.live.head.sha = "abcdef0"
    else f.state.main = "abcdef0"
    await expect(discoverReleaseCandidate(f)).rejects.toThrow("is not a full commit SHA")
  })
})

describe("verified release PR merge", () => {
  it("revalidates the live PR and main, then squashes the exact verified head", async () => {
    const f = fixture()
    const candidate = await discoverReleaseCandidate(f)
    await expect(mergeReleaseCandidate({ ...f, candidate })).resolves.toBe(mergeSha)
    expect(f.github.rest.pulls.get).toHaveBeenCalledTimes(2)
    expect(f.github.rest.git.getRef).toHaveBeenCalledTimes(2)
    expect(f.github.rest.repos.compareCommitsWithBasehead).toHaveBeenCalledTimes(2)
    expect(f.github.rest.pulls.merge).toHaveBeenCalledWith({
      ...context.repo,
      pull_number: 16,
      sha: headSha,
      merge_method: "squash",
      commit_title: f.state.live.title,
    })
    expect(f.github.rest.git.getCommit).toHaveBeenCalledWith({ ...context.repo, commit_sha: headSha })
    expect(f.github.rest.git.getCommit).toHaveBeenCalledWith({ ...context.repo, commit_sha: mergeSha })
    expect(f.github.rest.git.getCommit).toHaveBeenCalledTimes(2)
  })

  it.each(disallowedPulls)("refuses %s after verification", async (_name, mutate) => {
    const f = fixture()
    mutate(f.state.live)
    await expect(mergeReleaseCandidate({ ...f, candidate: verifiedCandidate() })).rejects.toThrow("no longer matches")
    expect(f.github.rest.pulls.merge).not.toHaveBeenCalled()
  })

  it("refuses a changed PR head", async () => {
    const f = fixture()
    f.state.live.head.sha = "d".repeat(40)
    await expect(mergeReleaseCandidate({ ...f, candidate: verifiedCandidate() })).rejects.toThrow(
      "head changed after verification",
    )
    expect(f.github.rest.pulls.merge).not.toHaveBeenCalled()
  })

  it("refuses a moved main even when the new main is included", async () => {
    const f = fixture()
    f.state.main = "d".repeat(40)
    f.state.mergeBase = f.state.main
    await expect(mergeReleaseCandidate({ ...f, candidate: verifiedCandidate() })).rejects.toThrow(
      "main changed after release verification",
    )
    expect(f.github.rest.pulls.merge).not.toHaveBeenCalled()
  })

  it("refuses a different eligible release branch after verification", async () => {
    const f = fixture()
    f.state.live.head.ref = "release-please--branches--main"
    await expect(mergeReleaseCandidate({ ...f, candidate: verifiedCandidate() })).rejects.toThrow(
      "head changed after verification",
    )
    expect(f.github.rest.pulls.merge).not.toHaveBeenCalled()
  })

  it("refuses stale ancestry during the final check", async () => {
    const f = fixture()
    f.state.mergeBase = "d".repeat(40)
    await expect(mergeReleaseCandidate({ ...f, candidate: verifiedCandidate() })).rejects.toThrow(
      "does not contain current main",
    )
    expect(f.github.rest.pulls.merge).not.toHaveBeenCalled()
  })

  it("fails when GitHub refuses the merge", async () => {
    const f = fixture()
    f.state.merge = { merged: false, sha: "", message: "Required checks have not passed" }
    await expect(mergeReleaseCandidate({ ...f, candidate: verifiedCandidate() })).rejects.toThrow(
      "GitHub refused to merge PR #16: Required checks have not passed",
    )
    expect(f.github.rest.pulls.merge).toHaveBeenCalledTimes(1)
  })

  it("propagates GitHub's head-race rejection without a second or bypassed merge", async () => {
    const f = fixture()
    f.github.rest.pulls.merge.mockRejectedValueOnce(new Error("409 Head SHA does not match"))
    await expect(mergeReleaseCandidate({ ...f, candidate: verifiedCandidate() })).rejects.toThrow(
      "409 Head SHA does not match",
    )
    expect(f.github.rest.pulls.merge).toHaveBeenCalledTimes(1)
  })

  it("rejects a malformed merge result instead of claiming success", async () => {
    const f = fixture()
    f.state.merge.sha = ""
    await expect(mergeReleaseCandidate({ ...f, candidate: verifiedCandidate() })).rejects.toThrow(
      "release merge commit is not a full commit SHA",
    )
  })

  it("refuses to release unverified main changes included by a merge-time base race", async () => {
    const f = fixture()
    f.state.mergedTree = "e".repeat(40)
    await expect(mergeReleaseCandidate({ ...f, candidate: verifiedCandidate() })).rejects.toThrow(
      "merged contents differ from the verified release head",
    )
    expect(f.github.rest.pulls.merge).toHaveBeenCalledTimes(1)
    expect(f.github.rest.git.getCommit).toHaveBeenCalledTimes(2)
  })

  it.each(["head", "merged"])("refuses an invalid %s tree with recovery for the merged PR", async (kind) => {
    const f = fixture()
    if (kind === "head") f.state.headTree = "invalid-tree"
    else f.state.mergedTree = "abcdef0"
    await expect(mergeReleaseCandidate({ ...f, candidate: verifiedCandidate() })).rejects.toThrow(
      "The PR is already merged. Rerun the Release workflow to verify current main before creating a tag",
    )
    expect(f.github.rest.pulls.merge).toHaveBeenCalledTimes(1)
  })

  it("rejects a missing verified candidate before any API mutation", async () => {
    const f = fixture()
    await expect(mergeReleaseCandidate({ ...f, candidate: null })).rejects.toThrow(
      "verified release PR number is missing",
    )
    expect(f.github.rest.pulls.get).not.toHaveBeenCalled()
    expect(f.github.rest.pulls.merge).not.toHaveBeenCalled()
  })
})
