import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { clearedGitEnvironment } from "@agent-valley/core/util/git-environment"
import { afterEach, describe, expect, it } from "vitest"
import { prepareDeliveryPatch } from "../chief-code-delivery-git"

const execute = promisify(execFile)
const directories: string[] = []
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execute("git", args, {
    cwd,
    env: { ...process.env, ...clearedGitEnvironment, GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  })
  return result.stdout.trim()
}

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "av-code-delivery-git-")))
  directories.push(directory)
  const source = join(directory, "source")
  const workspace = join(directory, "workspace")
  const remote = join(directory, "remote.git")
  const storage = join(directory, "storage")
  await mkdir(source)
  await mkdir(storage)
  await git(source, "init", "-b", "main")
  await git(source, "config", "user.name", "AV bounded Git fixture")
  await git(source, "config", "user.email", "fixture@example.test")
  await writeFile(join(source, "payload.txt"), "original payload\n")
  await git(source, "add", "payload.txt")
  await git(source, "commit", "-m", "test: seed bounded metadata fixture")
  await git(directory, "init", "--bare", "-b", "main", remote)
  await git(source, "remote", "add", "origin", remote)
  await git(source, "push", "origin", "main")
  await git(directory, "clone", "--quiet", source, workspace)
  return { source, workspace, remote, storage, baseSha: await git(source, "rev-parse", "HEAD") }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("bounded code delivery Git metadata", () => {
  it("rejects a patch above 2 MiB before changing the actual source/workspace indexes, HEAD or remote", async () => {
    const { source, workspace, remote, storage, baseSha } = await fixture()
    await writeFile(join(workspace, "payload.txt"), "private-metadata-must-not-escape\n".repeat(80_000))
    const sourceIndex = await git(source, "write-tree")
    const workspaceIndex = await git(workspace, "write-tree")
    const outcome = await prepareDeliveryPatch(workspace, baseSha, ["payload.txt"], storage).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(outcome).toBeInstanceOf(Error)
    const message = (outcome as Error).message
    expect(message).toContain("Code delivery Git command failed")
    expect(message.length).toBeLessThan(256)
    expect(message).not.toContain("private-metadata-must-not-escape")
    expect(await git(source, "write-tree")).toBe(sourceIndex)
    expect(await git(workspace, "write-tree")).toBe(workspaceIndex)
    expect(await git(source, "rev-parse", "HEAD")).toBe(baseSha)
    expect(await git(workspace, "rev-parse", "HEAD")).toBe(baseSha)
    expect(await git(remote, "rev-parse", "refs/heads/main")).toBe(baseSha)
    expect(await readFile(join(source, "payload.txt"), "utf8")).toBe("original payload\n")
  })

  it("round-trips a large Unicode diff and patch without corrupting multibyte characters", async () => {
    const { source, workspace, storage, baseSha } = await fixture()
    const content = "한글🙂café\n".repeat(24_000)
    await writeFile(join(workspace, "payload.txt"), content)
    const workspaceIndex = await git(workspace, "write-tree")

    const prepared = await prepareDeliveryPatch(workspace, baseSha, ["payload.txt"], storage)
    await git(source, "apply", "--index", "--binary", prepared.patchPath)

    expect(digest(await readFile(join(source, "payload.txt")))).toBe(digest(content))
    expect(await git(source, "write-tree")).toBe(prepared.treeSha)
    expect(digest(await readFile(prepared.patchPath))).toBe(prepared.patchSha256)
    expect(prepared.changedPaths).toEqual(["payload.txt"])
    expect(await git(workspace, "write-tree")).toBe(workspaceIndex)
  })
})
