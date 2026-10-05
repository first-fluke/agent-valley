import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createContinuousMissionWorkspace,
  prepareContinuousBaseline,
  validateContinuousBaseline,
} from "./continuous-workspace"
import { fingerprintWorkspace } from "./fingerprint"
import { parallelGit } from "./parallel-git"

let directory: string
let root: string
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "av-continuous-git-")))
  root = join(directory, "repository")
  await mkdir(root)
  await parallelGit(root, ["init", "-q", "-b", "main"])
  await writeFile(join(root, "product.txt"), "Initial product\n")
  await writeFile(join(root, "delete.txt"), "Delete later\n")
  await writeFile(join(root, "script.sh"), "#!/bin/sh\n")
  await mkdir(join(root, ".agents"))
  await writeFile(join(root, ".agents", "managed.txt"), "Tracked harness\n")
  await writeFile(join(root, ".gitignore"), ".agent-valley/\nignored.txt\n")
  await parallelGit(root, ["add", "."])
  await parallelGit(root, [
    "-c",
    "user.name=AV test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "initial",
  ])
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

describe("accepted continuous operation baselines", () => {
  it("carries staged, unstaged, untracked, deleted and executable product changes while preserving original index and refs", async () => {
    await writeFile(join(root, "product.txt"), "Staged product\n")
    await parallelGit(root, ["add", "product.txt"])
    await writeFile(join(root, "product.txt"), "Latest unstaged product\n")
    await writeFile(join(root, "new[1]*?.txt"), "Untracked product\n")
    await writeFile(join(root, "ignored.txt"), "Excluded untracked\n")
    await writeFile(join(root, ".agents", "managed.txt"), "Do not snapshot managed edits\n")
    await rm(join(root, "delete.txt"))
    await chmod(join(root, "script.sh"), 0o755)
    const index = await readFile(join(root, ".git", "index"))
    const refs = await parallelGit(root, ["show-ref"])
    const snapshot = await prepareContinuousBaseline(root, "operation", root)
    expect(await readFile(join(snapshot.path, "product.txt"), "utf8")).toBe("Latest unstaged product\n")
    expect(await readFile(join(snapshot.path, "new[1]*?.txt"), "utf8")).toBe("Untracked product\n")
    expect(await readFile(join(snapshot.path, ".agents", "managed.txt"), "utf8")).toBe("Tracked harness\n")
    expect((await lstat(join(snapshot.path, "script.sh"))).mode & 0o111).toBe(0o111)
    await expect(lstat(join(snapshot.path, "delete.txt"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(lstat(join(snapshot.path, "ignored.txt"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(join(root, ".git", "index"))).toEqual(index)
    expect(await parallelGit(root, ["show-ref"])).toBe(refs)
    expect(await prepareContinuousBaseline(root, "operation", root)).toEqual(snapshot)
  })

  it("uses sibling isolated children and carries accepted uncommitted results to a second cycle", async () => {
    const first = await prepareContinuousBaseline(root, "operation", root)
    const child = await createContinuousMissionWorkspace(root, "operation", first.path, "child-one", "Improve")
    await writeFile(join(child.path, "product.txt"), "Accepted first improvement\n")
    await writeFile(join(child.path, "cycle-one.txt"), "First accepted addition\n")
    expect(await createContinuousMissionWorkspace(root, "operation", first.path, "child-one", "Improve")).toEqual(child)
    expect(await validateContinuousBaseline(root, "operation", first.path)).toEqual(first)
    const accepted = await prepareContinuousBaseline(root, "operation", child.path, "child-one")
    const next = await createContinuousMissionWorkspace(root, "operation", accepted.path, "child-two", "Improve again")
    expect(await readFile(join(next.path, "product.txt"), "utf8")).toBe("Accepted first improvement\n")
    expect(await readFile(join(next.path, "cycle-one.txt"), "utf8")).toBe("First accepted addition\n")
    expect(await readFile(join(root, "product.txt"), "utf8")).toBe("Initial product\n")
    expect(await parallelGit(child.path, ["remote"])).toBe("")
  })

  it("replays an accepted snapshot transaction after its clone finished but final receipt was lost", async () => {
    const snapshot = await prepareContinuousBaseline(root, "operation", root)
    await rm(join(dirname(snapshot.path), "baseline.json"))
    await writeFile(join(root, "product.txt"), "Later unrelated change\n")
    expect(await prepareContinuousBaseline(root, "operation", root)).toEqual(snapshot)
    expect(await readFile(join(snapshot.path, "product.txt"), "utf8")).toBe("Initial product\n")
    expect(await readFile(join(root, "product.txt"), "utf8")).toBe("Later unrelated change\n")
  })

  it("restores a child receipt after clone completion without discarding the child's later edits", async () => {
    const snapshot = await prepareContinuousBaseline(root, "operation", root)
    const child = await createContinuousMissionWorkspace(root, "operation", snapshot.path, "child", "Improve")
    await rm(join(dirname(child.path), "workspace.json"))
    await writeFile(join(child.path, "product.txt"), "Preserve child edits\n")
    expect(await createContinuousMissionWorkspace(root, "operation", snapshot.path, "child", "Improve")).toEqual(child)
    expect(await readFile(join(child.path, "product.txt"), "utf8")).toBe("Preserve child edits\n")
  })

  it("rejects changed frozen products, foreign paths and changed receipt identity before creating another child", async () => {
    const snapshot = await prepareContinuousBaseline(root, "operation", root)
    await expect(validateContinuousBaseline(root, "operation", root)).rejects.toThrow("outside")
    await expect(validateContinuousBaseline(root, "other-operation", snapshot.path)).rejects.toThrow("outside")
    await writeFile(join(snapshot.path, "product.txt"), "Unexpected edits\n")
    await expect(createContinuousMissionWorkspace(root, "operation", snapshot.path, "next", "Improve")).rejects.toThrow(
      "product files changed",
    )
    await writeFile(join(snapshot.path, "product.txt"), "Initial product\n")
    await writeFile(
      join(dirname(snapshot.path), "baseline.json"),
      JSON.stringify({ ...snapshot, operationId: "other" }),
    )
    await expect(validateContinuousBaseline(root, "operation", snapshot.path)).rejects.toThrow("does not belong")
  })

  it("rejects symlinked storage and redirected Git metadata", async () => {
    await mkdir(join(root, ".agent-valley"))
    await mkdir(join(directory, "outside"))
    await symlink(join(directory, "outside"), join(root, ".agent-valley", "operations"))
    await expect(prepareContinuousBaseline(root, "operation", root)).rejects.toThrow("symlink")
    await rm(join(root, ".agent-valley", "operations"))
    const snapshot = await prepareContinuousBaseline(root, "operation", root)
    await rm(join(snapshot.path, ".git"), { recursive: true })
    await symlink(join(root, ".git"), join(snapshot.path, ".git"))
    await expect(validateContinuousBaseline(root, "operation", snapshot.path)).rejects.toThrow("independent")
  })

  it("does not redirect source or snapshot commands through inherited Git routing variables", async () => {
    const snapshot = await prepareContinuousBaseline(root, "operation", root)
    const child = await createContinuousMissionWorkspace(root, "operation", snapshot.path, "child", "Improve")
    await writeFile(join(child.path, "product.txt"), "Verified isolated improvement\n")
    const verified = await fingerprintWorkspace(child.path)
    vi.stubEnv("GIT_DIR", join(root, ".git"))
    vi.stubEnv("GIT_WORK_TREE", root)
    vi.stubEnv("GIT_INDEX_FILE", join(root, ".git", "index"))
    vi.stubEnv("GIT_COMMON_DIR", join(root, ".git"))
    expect((await parallelGit(snapshot.path, ["rev-parse", "HEAD"])).trim()).toBe(snapshot.commit)
    expect(await fingerprintWorkspace(child.path)).toBe(verified)
    const accepted = await prepareContinuousBaseline(root, "operation", child.path, "child", verified)
    expect(await readFile(join(accepted.path, "product.txt"), "utf8")).toBe("Verified isolated improvement\n")
    expect(await readFile(join(root, "product.txt"), "utf8")).toBe("Initial product\n")
  })

  it("requires the child's verified fingerprint before preparing a new accepted product snapshot", async () => {
    const initial = await prepareContinuousBaseline(root, "operation", root)
    const child = await createContinuousMissionWorkspace(root, "operation", initial.path, "child", "Improve")
    const verified = await fingerprintWorkspace(child.path)
    await writeFile(join(child.path, "product.txt"), "Unreviewed changes\n")
    await expect(prepareContinuousBaseline(root, "operation", child.path, "child", verified)).rejects.toThrow(
      "after verification",
    )
    await expect(
      lstat(join(root, ".agent-valley", "operations", "operation", "baselines", "child", "snapshot.json")),
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("replays a verified frozen snapshot without absorbing later source changes or weakening its verification identity", async () => {
    const verified = await fingerprintWorkspace(root)
    const snapshot = await prepareContinuousBaseline(root, "operation", root, "verified-child", verified)
    await rm(join(dirname(snapshot.path), "baseline.json"))
    await writeFile(join(root, "product.txt"), "Later unaccepted edit\n")
    expect(await prepareContinuousBaseline(root, "operation", root, "verified-child", verified)).toEqual(snapshot)
    expect(await readFile(join(snapshot.path, "product.txt"), "utf8")).toBe("Initial product\n")
    await expect(prepareContinuousBaseline(root, "operation", root, "verified-child", "a".repeat(64))).rejects.toThrow(
      "identity",
    )
  })
})
