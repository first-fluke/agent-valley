import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ContinuousBaseline } from "./continuous-contract"
import { operation as operationFixture } from "./continuous-operation.fixture"
import {
  integrateContinuousSource,
  prepareSourceIntegration,
  synchronizeContinuousBaselineWithSource,
} from "./continuous-source-integration"
import { createContinuousMissionWorkspace, prepareContinuousBaseline } from "./continuous-workspace"
import { fingerprintWorkspace } from "./fingerprint"
import { parallelGit } from "./parallel-git"

let directory: string
let root: string
const git = (args: string[]) => parallelGit(root, args)
const commit = (message: string) =>
  git([
    "-c",
    "user.name=AV test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    message,
  ])

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "av-baseline-sync-")))
  root = join(directory, "repository")
  await mkdir(root)
  await git(["init", "-q", "-b", "main"])
  for (const [path, contents] of Object.entries({
    "product.txt": "Initial product\n",
    "other.txt": "Initial other\n",
    "retired.txt": "Retired later\n",
    ".gitignore": ".agent-valley/\n",
  }))
    await writeFile(join(root, path), contents)
  await git(["add", "."])
  await commit("initial")
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function accepted(previous: ContinuousBaseline, edit: (path: string) => Promise<void>, id: string) {
  const child = await createContinuousMissionWorkspace(root, "operation", previous.path, id, "Improve")
  await edit(child.path)
  return prepareContinuousBaseline(root, "operation", child.path, id, await fingerprintWorkspace(child.path))
}

describe("continuous baseline source sync", () => {
  it("keeps a later accepted cycle when the operator commits an earlier accepted cycle", async () => {
    const operation = operationFixture({
      repositoryRoot: root,
      sourceIntegrationPolicy: await prepareSourceIntegration(root, "operation"),
    })
    const initial = await prepareContinuousBaseline(root, operation.id, root)
    const first = await accepted(
      initial,
      async (path) => {
        await writeFile(join(path, "product.txt"), "First cycle\n")
        await writeFile(join(path, "other.txt"), "First cycle other\n")
        await rm(join(path, "retired.txt"))
      },
      "first-child",
    )
    await integrateContinuousSource(operation, initial, first)
    // The operator commits the applied first cycle and one file of their own.
    await writeFile(join(root, "direct.txt"), "Operator direct commit\n")
    await git(["add", "-A", "--", "product.txt", "other.txt", "retired.txt", "direct.txt"])
    await commit("commit the applied first cycle")
    const head = (await git(["rev-parse", "HEAD"])).trim()
    // The second cycle was accepted before the source HEAD was pinned again.
    const second = await accepted(
      first,
      async (path) => {
        await writeFile(join(path, "product.txt"), "Second cycle\n")
        await writeFile(join(path, "retired.txt"), "Restored by the second cycle\n")
      },
      "second-child",
    )
    operation.baseline = second
    operation.sourceIntegrationPolicy = { mode: "worktree", branch: "main", head }

    const synced = await synchronizeContinuousBaselineWithSource(operation, second)

    if (!synced) throw new Error("expected a synchronized baseline")
    expect(await readFile(join(synced.path, "product.txt"), "utf8")).toBe("Second cycle\n")
    expect(await readFile(join(synced.path, "retired.txt"), "utf8")).toBe("Restored by the second cycle\n")
    expect(await readFile(join(synced.path, "other.txt"), "utf8")).toBe("First cycle other\n")
    expect(await readFile(join(synced.path, "direct.txt"), "utf8")).toBe("Operator direct commit\n")
    await expect(parallelGit(synced.path, ["merge-base", "--is-ancestor", head, synced.commit])).resolves.toBe("")
  })

  it("lets an operator edit the accepted lineage never held win over the baseline", async () => {
    const operation = operationFixture({
      repositoryRoot: root,
      sourceIntegrationPolicy: await prepareSourceIntegration(root, "operation"),
    })
    const initial = await prepareContinuousBaseline(root, operation.id, root)
    const first = await accepted(
      initial,
      (path) => writeFile(join(path, "product.txt"), "First cycle\n"),
      "first-child",
    )
    await writeFile(join(root, "product.txt"), "Operator rewrite\n")
    await git(["add", "--", "product.txt"])
    await commit("operator rewrite")
    const head = (await git(["rev-parse", "HEAD"])).trim()
    operation.baseline = first
    operation.sourceIntegrationPolicy = { mode: "worktree", branch: "main", head }

    const synced = await synchronizeContinuousBaselineWithSource(operation, first)

    if (!synced) throw new Error("expected a synchronized baseline")
    expect(await readFile(join(synced.path, "product.txt"), "utf8")).toBe("Operator rewrite\n")
  })
  it("carries a link the operator committed or removed into the baseline", async () => {
    await symlink("product.txt", join(root, "retired-link.txt"))
    await git(["add", "--", "retired-link.txt"])
    await commit("add a link")
    const operation = operationFixture({
      repositoryRoot: root,
      sourceIntegrationPolicy: await prepareSourceIntegration(root, "operation"),
    })
    const initial = await prepareContinuousBaseline(root, operation.id, root)
    await rm(join(root, "retired-link.txt"))
    await symlink("other.txt", join(root, "added-link.txt"))
    await git(["add", "-A", "--", "retired-link.txt", "added-link.txt"])
    await commit("replace the link")
    const head = (await git(["rev-parse", "HEAD"])).trim()
    operation.baseline = initial
    operation.sourceIntegrationPolicy = { mode: "worktree", branch: "main", head }

    const synced = await synchronizeContinuousBaselineWithSource(operation, initial)

    if (!synced) throw new Error("expected a synchronized baseline")
    expect(await readlink(join(synced.path, "added-link.txt"))).toBe("other.txt")
    await expect(lstat(join(synced.path, "retired-link.txt"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(join(synced.path, "product.txt"), "utf8")).toBe("Initial product\n")
  })
})
