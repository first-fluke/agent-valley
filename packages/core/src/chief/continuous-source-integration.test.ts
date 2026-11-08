import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { appendRuntimeGitignoreRule } from "../workspace/runtime-ignore"
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
const recordPath = (mission = "child") =>
  join(root, ".agent-valley", "operations", "operation", "source-integrations", mission, "integration.json")

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "av-source-integration-")))
  root = join(directory, "repository")
  await mkdir(root)
  await git(["init", "-q", "-b", "main"])
  for (const [path, contents] of Object.entries({
    "product.txt": "Initial product\n",
    "other.txt": "Other product\n",
    "delete.txt": "Delete later\n",
    "script.sh": "#!/bin/sh\n",
    ".gitignore": ".agent-valley/\n",
  }))
    await writeFile(join(root, path), contents)
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2]))
  await mkdir(join(root, ".qwen"))
  await writeFile(join(root, ".qwen", "settings.json"), "original client config\n")
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

async function fixture() {
  const operation = operationFixture({
    repositoryRoot: root,
    sourceIntegrationPolicy: await prepareSourceIntegration(root, "operation"),
  })
  const previous = await prepareContinuousBaseline(root, operation.id, root)
  return { operation, previous }
}

async function accepted(previous: ContinuousBaseline, edit: (path: string) => Promise<void>, id = "child") {
  const child = await createContinuousMissionWorkspace(root, "operation", previous.path, id, "Improve")
  await edit(child.path)
  return prepareContinuousBaseline(root, "operation", child.path, id, await fingerprintWorkspace(child.path))
}

describe("continuous verified source worktree integration", () => {
  it("applies only the cycle delta and preserves unrelated staging, worktree, untracked files and refs", async () => {
    await writeFile(join(root, "other.txt"), "Staged operator work\n")
    await git(["add", "other.txt"])
    await writeFile(join(root, "other.txt"), "Unstaged continuation\n")
    await writeFile(join(root, "notes.txt"), "Untracked operator work\n")
    const { operation, previous } = await fixture()
    const next = await accepted(previous, (path) => writeFile(join(path, "product.txt"), "Verified product\n"))
    const index = await readFile(join(root, ".git", "index"))
    const refs = await git(["show-ref"])

    const result = await integrateContinuousSource(operation, previous, next)

    expect(result).toMatchObject({
      phase: "applied",
      paths: ["product.txt"],
      branch: "main",
      previousTree: previous.baselineTree,
      nextTree: next.baselineTree,
    })
    expect(await readFile(join(root, "product.txt"), "utf8")).toBe("Verified product\n")
    expect(await readFile(join(root, "other.txt"), "utf8")).toBe("Unstaged continuation\n")
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("Untracked operator work\n")
    expect(await readFile(join(root, ".git", "index"))).toEqual(index)
    expect(await git(["show-ref"])).toBe(refs)
    expect(await integrateContinuousSource(operation, previous, next)).toEqual(result)
  })

  it("carries binary, executable, deletion and added-file deltas through successive verified cycles", async () => {
    const { operation, previous } = await fixture()
    const first = await accepted(previous, async (path) => {
      await writeFile(join(path, "binary.bin"), Buffer.from([0, 255, 9, 0]))
      await chmod(join(path, "script.sh"), 0o755)
      await rm(join(path, "delete.txt"))
      await writeFile(join(path, "new.txt"), "First cycle\n")
    })
    await integrateContinuousSource(operation, previous, first)
    const second = await accepted(first, (path) => writeFile(join(path, "new.txt"), "Second cycle\n"), "second-child")

    const result = await integrateContinuousSource(operation, first, second)

    expect(result.paths).toEqual(["new.txt"])
    expect(await readFile(join(root, "binary.bin"))).toEqual(Buffer.from([0, 255, 9, 0]))
    expect((await lstat(join(root, "script.sh"))).mode & 0o111).toBe(0o111)
    await expect(lstat(join(root, "delete.txt"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("Second cycle\n")
  })

  it("rejects overlapping source edits before applying any part of the cycle", async () => {
    const { operation, previous } = await fixture()
    const next = await accepted(previous, async (path) => {
      await writeFile(join(path, "product.txt"), "Verified product\n")
      await writeFile(join(path, "new.txt"), "Verified addition\n")
    })
    await writeFile(join(root, "product.txt"), "Concurrent operator edit\n")

    await expect(integrateContinuousSource(operation, previous, next)).rejects.toThrow("overlap")

    expect(await readFile(join(root, "product.txt"), "utf8")).toBe("Concurrent operator edit\n")
    await expect(lstat(join(root, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects staged changes on a target path while preserving the index bytes", async () => {
    const { operation, previous } = await fixture()
    const next = await accepted(previous, (path) => writeFile(join(path, "product.txt"), "Verified product\n"))
    await writeFile(join(root, "product.txt"), "Staged operator edit\n")
    await git(["add", "product.txt"])
    await writeFile(join(root, "product.txt"), "Initial product\n")
    const index = await readFile(join(root, ".git", "index"))

    await expect(integrateContinuousSource(operation, previous, next)).rejects.toThrow("staged operator changes")

    expect(await readFile(join(root, ".git", "index"))).toEqual(index)
    expect(await readFile(join(root, "product.txt"), "utf8")).toBe("Initial product\n")
  })

  it.each(["branch", "head"])("rejects source %s drift from the saved policy", async (kind) => {
    const { operation, previous } = await fixture()
    const next = await accepted(previous, (path) => writeFile(join(path, "product.txt"), "Verified product\n"))
    // A rewritten HEAD is not a fast-forward of the pinned head, so it still needs reconciliation.
    if (kind === "branch") await git(["checkout", "-qb", "changed"])
    else
      await git([
        "-c",
        "user.name=AV test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--amend",
        "--allow-empty",
        "-qm",
        "rewritten history",
      ])

    await expect(integrateContinuousSource(operation, previous, next)).rejects.toThrow("branch or HEAD moved")
    expect(await readFile(join(root, "product.txt"), "utf8")).toBe("Initial product\n")
  })

  it("re-pins a clean fast-forward commit of the applied source and integrates", async () => {
    const { operation, previous } = await fixture()
    const next = await accepted(previous, (path) => writeFile(join(path, "product.txt"), "Verified product\n"))
    await git([
      "-c",
      "user.name=AV test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "operator committed the applied tree",
    ])
    const head = (await git(["rev-parse", "HEAD"])).trim()

    const summary = await integrateContinuousSource(operation, previous, next)

    expect(summary.phase).toBe("applied")
    expect(operation.sourceIntegrationPolicy).toMatchObject({ mode: "worktree", head })
    expect(await readFile(join(root, "product.txt"), "utf8")).toBe("Verified product\n")
  })

  it("recognizes a completed apply whose final receipt save was interrupted", async () => {
    const { operation, previous } = await fixture()
    const next = await accepted(previous, (path) => writeFile(join(path, "product.txt"), "Verified product\n"))
    await integrateContinuousSource(operation, previous, next)
    const receipt = JSON.parse(await readFile(recordPath(), "utf8"))
    receipt.status = "applying"
    delete receipt.at
    await writeFile(recordPath(), JSON.stringify(receipt))

    const result = await integrateContinuousSource(operation, previous, next)

    expect(result.phase).toBe("applied")
    expect(JSON.parse(await readFile(recordPath(), "utf8")).status).toBe("applied")
    expect(await readFile(join(root, "product.txt"), "utf8")).toBe("Verified product\n")
  })

  it("preserves unknown partial application rather than replaying the patch", async () => {
    const { operation, previous } = await fixture()
    const next = await accepted(previous, async (path) => {
      await writeFile(join(path, "product.txt"), "Verified product\n")
      await writeFile(join(path, "other.txt"), "Verified other\n")
    })
    await integrateContinuousSource(operation, previous, next)
    const receipt = JSON.parse(await readFile(recordPath(), "utf8"))
    receipt.status = "applying"
    await writeFile(recordPath(), JSON.stringify(receipt))
    await writeFile(join(root, "other.txt"), "Other product\n")

    await expect(integrateContinuousSource(operation, previous, next)).rejects.toThrow("interrupted")

    expect(await readFile(join(root, "product.txt"), "utf8")).toBe("Verified product\n")
    expect(await readFile(join(root, "other.txt"), "utf8")).toBe("Other product\n")
  })

  it("does not copy native client, MCP, project configuration or credential files", async () => {
    const { operation, previous } = await fixture()
    const next = await accepted(previous, async (path) => {
      await writeFile(join(path, ".qwen", "settings.json"), "child client config\n")
      await writeFile(join(path, "av.yaml"), "child project config\n")
      await writeFile(join(path, ".mcp.json"), "child MCP config\n")
      await writeFile(join(path, "opencode.json"), "child OpenCode config\n")
      await writeFile(join(path, "credentials.json"), "child credential fixture\n")
      await writeFile(join(path, "product.txt"), "Verified product\n")
    })

    const result = await integrateContinuousSource(operation, previous, next)

    expect(result.paths).toEqual(["product.txt"])
    expect(await readFile(join(root, ".qwen", "settings.json"), "utf8")).toBe("original client config\n")
    for (const file of ["av.yaml", ".mcp.json", "opencode.json", "credentials.json"])
      await expect(lstat(join(root, file))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("reports unchanged when the verified cycle has no product delta", async () => {
    const { operation, previous } = await fixture()
    const next = await accepted(previous, async () => {})

    expect(await integrateContinuousSource(operation, previous, next)).toMatchObject({ phase: "unchanged", paths: [] })
  })

  it("accepts a startup gitignore rule already present in source and applies only the remaining verified delta", async () => {
    await writeFile(join(root, ".gitignore"), "")
    const { operation, previous } = await fixture()
    const next = await accepted(previous, async (path) => {
      await writeFile(join(path, ".gitignore"), ".agent-valley/\n")
      await writeFile(join(path, "product.txt"), "Verified product\n")
    })
    await writeFile(join(root, ".gitignore"), ".agent-valley/\n")
    const index = await readFile(join(root, ".git", "index"))

    const result = await integrateContinuousSource(operation, previous, next)

    expect(result).toMatchObject({ phase: "applied", paths: ["product.txt"] })
    const receipt = JSON.parse(await readFile(recordPath(), "utf8"))
    expect(receipt.alreadySatisfied).toEqual([".gitignore"])
    expect(receipt.verifiedChanges.map((change: { path: string }) => change.path)).toEqual([
      ".gitignore",
      "product.txt",
    ])
    expect(receipt.changes.map((change: { path: string }) => change.path)).toEqual(["product.txt"])
    expect(await readFile(receipt.patchPath, "utf8")).not.toContain("diff --git a/.gitignore")
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(".agent-valley/\n")
    expect(await readFile(join(root, "product.txt"), "utf8")).toBe("Verified product\n")
    expect(await readFile(join(root, ".git", "index"))).toEqual(index)
  })

  it("reports unchanged when every verified after-image was present before preparation", async () => {
    const { operation, previous } = await fixture()
    const next = await accepted(previous, (path) => writeFile(join(path, "product.txt"), "Verified product\n"))
    await writeFile(join(root, "product.txt"), "Verified product\n")

    const result = await integrateContinuousSource(operation, previous, next)

    expect(result).toMatchObject({ phase: "unchanged", paths: [] })
    const receipt = JSON.parse(await readFile(recordPath(), "utf8"))
    expect(receipt.alreadySatisfied).toEqual(["product.txt"])
    expect(receipt.verifiedChanges).toHaveLength(1)
    expect(receipt.changes).toEqual([])
    expect(await readFile(receipt.patchPath, "utf8")).toBe("")
    expect(await integrateContinuousSource(operation, previous, next)).toEqual(result)
  })

  it("does not skip a mode-only change unless both the blob and executable mode already match", async () => {
    const { operation, previous } = await fixture()
    const next = await accepted(previous, (path) => chmod(join(path, "script.sh"), 0o755))

    await integrateContinuousSource(operation, previous, next)

    expect(JSON.parse(await readFile(recordPath(), "utf8")).alreadySatisfied).toEqual([])
    expect((await lstat(join(root, "script.sh"))).mode & 0o111).toBe(0o111)
  })

  it.each(["existing/\n", "existing/", "existing/\r\n"])(
    "projects only AV's canonical runtime append while applying the verified target rule: %j",
    async (initialIgnore) => {
      await writeFile(join(root, ".gitignore"), initialIgnore)
      const { operation, previous } = await fixture()
      const newline = initialIgnore.includes("\r\n") ? "\r\n" : "\n"
      const verifiedIgnore = `${initialIgnore}${initialIgnore.endsWith("\n") ? "" : newline}/target/${newline}`
      const next = await accepted(previous, async (path) => {
        await writeFile(join(path, ".gitignore"), verifiedIgnore)
        await writeFile(join(path, "product.txt"), "Verified product\n")
      })
      await writeFile(join(root, ".gitignore"), appendRuntimeGitignoreRule(initialIgnore))
      await writeFile(join(root, "other.txt"), "Staged operator edit\n")
      await git(["add", "other.txt"])
      await writeFile(join(root, "other.txt"), "Unstaged operator continuation\n")
      const index = await readFile(join(root, ".git", "index"))
      const refs = await git(["show-ref"])

      const result = await integrateContinuousSource(operation, previous, next)

      expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(appendRuntimeGitignoreRule(verifiedIgnore))
      expect(await readFile(join(previous.path, ".gitignore"), "utf8")).toBe(initialIgnore)
      expect(await readFile(join(next.path, ".gitignore"), "utf8")).toBe(verifiedIgnore)
      expect(await readFile(join(root, ".git", "index"))).toEqual(index)
      expect(await git(["show-ref"])).toBe(refs)
      expect(await readFile(join(root, "other.txt"), "utf8")).toBe("Unstaged operator continuation\n")
      const receipt = JSON.parse(await readFile(recordPath(), "utf8"))
      expect(receipt.gitignoreProjection.verifiedBefore).toEqual(
        receipt.verifiedChanges.find((change: { path: string }) => change.path === ".gitignore").before,
      )
      expect(receipt.gitignoreProjection.verifiedAfter).toEqual(
        receipt.verifiedChanges.find((change: { path: string }) => change.path === ".gitignore").after,
      )
      expect(receipt.gitignoreProjection.sourceBefore).not.toEqual(receipt.gitignoreProjection.verifiedBefore)
      expect(receipt.gitignoreProjection.sourceAfter).not.toEqual(receipt.gitignoreProjection.verifiedAfter)
      expect(await integrateContinuousSource(operation, previous, next)).toEqual(result)
    },
  )

  it("does not project arbitrary source ignore edits or delete the runtime-protected ignore file", async () => {
    await writeFile(join(root, ".gitignore"), "existing/\n")
    const { operation, previous } = await fixture()
    const next = await accepted(previous, (path) => writeFile(join(path, ".gitignore"), "existing/\n/target/\n"))
    const userIgnore = `${appendRuntimeGitignoreRule("existing/\n")}# unrelated operator rule\n`
    await writeFile(join(root, ".gitignore"), userIgnore)

    await expect(integrateContinuousSource(operation, previous, next)).rejects.toThrow("overlap")
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(userIgnore)
    const deletion = await accepted(previous, (path) => rm(join(path, ".gitignore")), "delete-ignore")
    await writeFile(join(root, ".gitignore"), appendRuntimeGitignoreRule("existing/\n"))

    await expect(integrateContinuousSource(operation, previous, deletion)).rejects.toThrow("cannot delete")
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(appendRuntimeGitignoreRule("existing/\n"))
  })

  it("rejects a tampered runtime-ignore projection without changing either verified or source bytes", async () => {
    await writeFile(join(root, ".gitignore"), "existing/\n")
    const { operation, previous } = await fixture()
    const next = await accepted(previous, (path) => writeFile(join(path, ".gitignore"), "existing/\n/target/\n"))
    await writeFile(join(root, ".gitignore"), appendRuntimeGitignoreRule("existing/\n"))
    await integrateContinuousSource(operation, previous, next)
    const result = await readFile(join(root, ".gitignore"), "utf8")
    const receipt = JSON.parse(await readFile(recordPath(), "utf8"))
    receipt.gitignoreProjection.sourceAfter.oid = "0".repeat(40)
    await writeFile(recordPath(), JSON.stringify(receipt))

    await expect(integrateContinuousSource(operation, previous, next)).rejects.toThrow(
      "saved runtime-ignore projection differs",
    )

    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(result)
    expect(await readFile(join(next.path, ".gitignore"), "utf8")).toBe("existing/\n/target/\n")
  })

  it("rejects symlinked product paths and private receipt storage", async () => {
    const { operation, previous } = await fixture()
    const linked = await accepted(previous, (path) => symlink("product.txt", join(path, "linked.txt")))
    await expect(integrateContinuousSource(operation, previous, linked)).rejects.toThrow("symbolic link")
    const next = await accepted(
      previous,
      (path) => writeFile(join(path, "product.txt"), "Verified product\n"),
      "regular-child",
    )
    const outside = join(directory, "outside")
    await mkdir(outside)
    await rm(join(root, ".agent-valley", "operations", "operation", "source-integrations"), { recursive: true })
    await symlink(outside, join(root, ".agent-valley", "operations", "operation", "source-integrations"))

    await expect(integrateContinuousSource(operation, previous, next)).rejects.toThrow("storage redirects")
    await expect(lstat(join(outside, "regular-child"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(join(root, "product.txt"), "utf8")).toBe("Initial product\n")
  })

  it("rejects a symlinked source target and a tampered immutable patch", async () => {
    const { operation, previous } = await fixture()
    const next = await accepted(previous, (path) => writeFile(join(path, "product.txt"), "Verified product\n"))
    const outside = join(directory, "outside.txt")
    await writeFile(outside, "Outside bytes\n")
    await rm(join(root, "product.txt"))
    await symlink(outside, join(root, "product.txt"))
    await expect(integrateContinuousSource(operation, previous, next)).rejects.toThrow("redirects")
    expect(await readFile(outside, "utf8")).toBe("Outside bytes\n")
    await rm(join(root, "product.txt"))
    await writeFile(join(root, "product.txt"), "Initial product\n")
    const receipt = JSON.parse(await readFile(recordPath(), "utf8"))
    await writeFile(receipt.patchPath, "tampered patch")

    await expect(integrateContinuousSource(operation, previous, next)).rejects.toThrow("patch changed")
    expect(await readFile(join(root, "product.txt"), "utf8")).toBe("Initial product\n")
  })

  it("does not apply after cancellation or without verified snapshot evidence", async () => {
    const { operation, previous } = await fixture()
    const next = await accepted(previous, (path) => writeFile(join(path, "product.txt"), "Verified product\n"))
    const controller = new AbortController()
    controller.abort(new Error("operator cancelled"))
    await expect(integrateContinuousSource(operation, previous, next, controller.signal)).rejects.toThrow("cancelled")
    await expect(
      integrateContinuousSource(operation, previous, { ...next, verifiedFingerprint: undefined }),
    ).rejects.toThrow("verified snapshot")
    expect(await readFile(join(root, "product.txt"), "utf8")).toBe("Initial product\n")
  })

  it("back-propagates operator direct commits on source branch to the accepted operation baseline", async () => {
    const { operation, previous } = await fixture()
    const next = await accepted(previous, (path) => writeFile(join(path, "product.txt"), "Verified product\n"))
    await integrateContinuousSource(operation, previous, next)
    operation.baseline = next

    // Operator makes direct commits to root (main)
    await writeFile(join(root, "direct.txt"), "Operator direct commit\n")
    await git(["add", "direct.txt"])
    await git([
      "-c",
      "user.name=AV test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "operator direct work",
    ])
    const newHead = (await git(["rev-parse", "HEAD"])).trim()
    operation.sourceIntegrationPolicy = { mode: "worktree", branch: "main", head: newHead }

    const synced = await synchronizeContinuousBaselineWithSource(operation, next)
    expect(synced).toBeDefined()
    expect(await readFile(join(synced!.path, "direct.txt"), "utf8")).toBe("Operator direct commit\n")
    expect(await readFile(join(synced!.path, "product.txt"), "utf8")).toBe("Verified product\n")
  })
})
