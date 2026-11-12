import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { operation as operationFixture } from "./continuous-operation.fixture"
import { integrateContinuousSource, prepareSourceIntegration } from "./continuous-source-integration"
import { createContinuousMissionWorkspace, prepareContinuousBaseline } from "./continuous-workspace"
import { fingerprintWorkspace } from "./fingerprint"
import { parallelGit } from "./parallel-git"

let directory: string
let root: string
const git = (args: string[]) => parallelGit(root, args)

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "av-source-ignored-")))
  root = join(directory, "repository")
  await mkdir(root)
  await git(["init", "-q", "-b", "main"])
  await writeFile(join(root, "product.txt"), "Initial product\n")
  await writeFile(join(root, ".gitignore"), ".agent-valley/\n/target/\n")
  await git(["add", "."])
  await git([
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
  await rm(directory, { recursive: true, force: true })
})

describe("verified source paths that the source ignores", () => {
  it("applies and confirms a file the child tracked despite an ignore rule", async () => {
    const operation = operationFixture({
      repositoryRoot: root,
      sourceIntegrationPolicy: await prepareSourceIntegration(root, "operation"),
    })
    const previous = await prepareContinuousBaseline(root, operation.id, root)
    const child = await createContinuousMissionWorkspace(root, "operation", previous.path, "child", "Improve")
    await mkdir(join(child.path, "target", "advice"), { recursive: true })
    await writeFile(join(child.path, "target", "advice", "design.md"), "Tracked despite ignore\n")
    await parallelGit(child.path, ["add", "-f", "target/advice/design.md"])
    const next = await prepareContinuousBaseline(
      root,
      "operation",
      child.path,
      "child",
      await fingerprintWorkspace(child.path),
    )

    const result = await integrateContinuousSource(operation, previous, next)

    expect(result).toMatchObject({ phase: "applied", paths: ["target/advice/design.md"] })
    expect(await readFile(join(root, "target", "advice", "design.md"), "utf8")).toBe("Tracked despite ignore\n")
    // A resumed integration finds the applied receipt and still confirms the ignored path.
    expect(await integrateContinuousSource(operation, previous, next)).toMatchObject({ phase: "applied" })
  })
})
