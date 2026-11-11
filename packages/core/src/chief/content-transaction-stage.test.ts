import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { stageIntegratedPaths } from "./content-transaction"

const run = promisify(execFile)
const roots: string[] = []
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "av",
      GIT_AUTHOR_EMAIL: "av@example.com",
      GIT_COMMITTER_NAME: "av",
      GIT_COMMITTER_EMAIL: "av@example.com",
    },
  })
  return stdout
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("stageIntegratedPaths", () => {
  it("stages delivered new and modified files but leaves intentionally untracked files alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "av-stage-"))
    roots.push(root)
    await git(root, "init", "-q", "-b", "main")
    await writeFile(join(root, "tracked.txt"), "one\n")
    await writeFile(join(root, "untracked-later.txt"), "keep\n")
    await git(root, "add", "tracked.txt", "untracked-later.txt")
    await git(root, "commit", "-q", "-m", "base")
    await git(root, "rm", "-q", "--cached", "untracked-later.txt")
    // A delivery applied with `git apply` changes the worktree only.
    await writeFile(join(root, "tracked.txt"), "two\n")
    await writeFile(join(root, "evidence.md"), "new\n")
    await writeFile(join(root, "untracked-later.txt"), "changed\n")

    await stageIntegratedPaths(root, ["tracked.txt", "evidence.md", "untracked-later.txt"])

    const status = (await git(root, "status", "--porcelain", "-z")).split("\0").filter(Boolean).sort()
    expect(status).toEqual(["?? untracked-later.txt", "A  evidence.md", "D  untracked-later.txt", "M  tracked.txt"])
  })

  it("is a no-op without delivered paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "av-stage-"))
    roots.push(root)
    await git(root, "init", "-q", "-b", "main")
    await writeFile(join(root, "a.txt"), "a\n")
    await git(root, "add", "a.txt")
    await git(root, "commit", "-q", "-m", "base")
    await stageIntegratedPaths(root, [])
    expect((await git(root, "status", "--porcelain")).trim()).toBe("")
  })
})
