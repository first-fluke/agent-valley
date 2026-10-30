import { execFile } from "node:child_process"
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { makeIssue } from "../__tests__/characterization/helpers"
import { clearedGitEnvironment } from "../util/git-environment"
import { WorkspaceManager } from "./workspace-manager"
import { createWorkspace } from "./worktree-lifecycle"

const execute = promisify(execFile)
const directories: string[] = []

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execute("git", args, { cwd, env: { ...process.env, ...clearedGitEnvironment } })
  return result.stdout.trim()
}

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "av-workspace-destination-")))
  directories.push(directory)
  const source = join(directory, "source")
  await mkdir(source)
  await git(source, "init", "-b", "main")
  await git(source, "config", "user.name", "AV destination fixture")
  await git(source, "config", "user.email", "fixture@example.test")
  await writeFile(join(source, ".gitignore"), ".agent-valley/\n")
  await writeFile(join(source, "product.txt"), "original product\n")
  await git(source, "add", ".gitignore", "product.txt")
  await git(source, "commit", "-m", "test: seed workspace destination fixture")
  return {
    directory,
    source,
    destination: join(source, ".agent-valley", "workspaces"),
    sourceHead: await git(source, "rev-parse", "HEAD"),
    sourceIndex: await git(source, "write-tree"),
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("workspace repository and destination separation", () => {
  it.each(["darwin", "linux"] as const)(
    "creates and reuses a valid %s workspace in a missing nested destination while preserving the source",
    async (platform) => {
      const { source, destination, sourceHead, sourceIndex } = await fixture()
      const issue = makeIssue({ id: `destination-${platform}`, identifier: `DEST-${platform}` })
      await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" })

      const workspace = await createWorkspace(source, issue, platform, destination)

      expect(workspace.path).toBe(join(destination, issue.identifier))
      expect(await realpath(await git(workspace.path, "rev-parse", "--show-toplevel"))).toBe(workspace.path)
      expect(await git(workspace.path, "branch", "--show-current")).toBe(workspace.branch)
      expect(await git(workspace.path, "rev-parse", "HEAD")).toBe(sourceHead)
      expect((await lstat(join(workspace.path, ".git"))).isDirectory()).toBe(platform === "linux")
      if (platform === "darwin")
        expect(await git(source, "worktree", "list", "--porcelain")).toContain(`worktree ${workspace.path}`)
      expect(JSON.parse(await readFile(join(workspace.path, ".agent-valley", "issue.json"), "utf8"))).toMatchObject({
        issueId: issue.id,
        branch: workspace.branch,
      })
      const branches = await git(source, "for-each-ref", "--format=%(refname)", "refs/heads")
      await writeFile(join(workspace.path, "retained.txt"), "preserve existing workspace edits\n")

      const reused = await createWorkspace(source, issue, platform, destination)

      expect(reused).toMatchObject({
        issueId: workspace.issueId,
        key: workspace.key,
        path: workspace.path,
        branch: workspace.branch,
      })
      expect(await readFile(join(reused.path, "retained.txt"), "utf8")).toBe("preserve existing workspace edits\n")
      expect(await git(source, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe(branches)
      expect(await git(source, "status", "--porcelain=v1", "--untracked-files=all")).toBe("")
      expect(await git(source, "rev-parse", "HEAD")).toBe(sourceHead)
      expect(await git(source, "write-tree")).toBe(sourceIndex)
    },
  )

  it("forwards a repository override and a separate destination through the WorkspaceManager facade", async () => {
    const { directory, source, destination, sourceHead, sourceIndex } = await fixture()
    const manager = new WorkspaceManager(join(directory, "unused-default-repository"))
    const issue = makeIssue({ id: "facade-destination", identifier: "DEST-facade" })

    const workspace = await manager.create(issue, source, destination)

    expect(workspace.path).toBe(join(destination, issue.identifier))
    expect(await git(workspace.path, "rev-parse", "HEAD")).toBe(sourceHead)
    expect(await git(source, "status", "--porcelain=v1", "--untracked-files=all")).toBe("")
    expect(await git(source, "rev-parse", "HEAD")).toBe(sourceHead)
    expect(await git(source, "write-tree")).toBe(sourceIndex)
  })
})
