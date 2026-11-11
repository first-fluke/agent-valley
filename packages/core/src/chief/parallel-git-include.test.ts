import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { captureParallelBaseline, parallelTreeImages } from "./parallel-git"

const run = promisify(execFile)
const roots: string[] = []
const identity = {
  GIT_AUTHOR_NAME: "av",
  GIT_AUTHOR_EMAIL: "av@example.com",
  GIT_COMMITTER_NAME: "av",
  GIT_COMMITTER_EMAIL: "av@example.com",
}
async function git(cwd: string, ...args: string[]): Promise<void> {
  await run("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, env: { ...process.env, ...identity } })
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("captureParallelBaseline include", () => {
  it("captures delivered files that the target repository ignores", async () => {
    const root = await mkdtemp(join(tmpdir(), "av-include-"))
    roots.push(root)
    await git(root, "init", "-q", "-b", "main")
    await writeFile(join(root, ".gitignore"), "coverage/\n")
    await writeFile(join(root, "kept.txt"), "kept\n")
    await git(root, "add", ".gitignore", "kept.txt")
    await git(root, "commit", "-q", "-m", "base")
    await mkdir(join(root, "scripts", "archive", "coverage"), { recursive: true })
    await writeFile(join(root, "scripts", "archive", "coverage", "tool.ts"), "export {}\n")

    const hidden = await parallelTreeImages(root, (await captureParallelBaseline(root)).tree)
    expect(hidden.has("scripts/archive/coverage/tool.ts")).toBe(false)

    const include = ["scripts/archive/coverage/tool.ts", "scripts/archive/coverage/deleted-by-delivery.ts"]
    const visible = await parallelTreeImages(root, (await captureParallelBaseline(root, { include })).tree)
    expect(visible.has("scripts/archive/coverage/tool.ts")).toBe(true)
    expect(visible.has("scripts/archive/coverage/deleted-by-delivery.ts")).toBe(false)
    expect(visible.has("kept.txt")).toBe(true)
  })
})
