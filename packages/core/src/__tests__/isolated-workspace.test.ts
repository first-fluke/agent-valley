import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { Issue } from "../domain/models"
import { mergeAndPush } from "../workspace/delivery-strategy"
import { createWorkspace } from "../workspace/worktree-lifecycle"

let fixture: string
let repo: string

function git(path: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), "av-isolated-identity-"))
  repo = join(fixture, "repo")
  await mkdir(repo)
  const globalConfig = join(fixture, "empty.gitconfig")
  await writeFile(globalConfig, "")
  vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig)
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1")
  for (const name of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"])
    vi.stubEnv(name, undefined)
  git(repo, "init", "-qb", "main")
  git(repo, "config", "--local", "user.name", "Repository Agent")
  git(repo, "config", "--local", "user.email", "repository-agent@example.invalid")
  await writeFile(join(repo, "README.md"), "base\n")
  git(repo, "add", "README.md")
  git(repo, "commit", "-qm", "base")
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(fixture, { recursive: true, force: true })
})

describe("Linux isolated workspace identity", () => {
  test("preserves repository-local commit identity without copying other config", async () => {
    git(repo, "config", "--local", "credential.helper", "fixture-helper-do-not-copy")
    git(repo, "config", "--local", "core.hooksPath", "fixture-hooks-do-not-copy")
    const workspace = await createWorkspace(
      repo,
      { id: "isolated", identifier: "LINUX-1", title: "feat: isolated commit" } as Issue,
      "linux",
    )

    expect(git(workspace.path, "config", "--local", "user.name")).toBe("Repository Agent")
    expect(git(workspace.path, "config", "--local", "user.email")).toBe("repository-agent@example.invalid")
    const cloneConfig = git(workspace.path, "config", "--local", "--list")
    expect(cloneConfig).not.toContain("credential.helper")
    expect(cloneConfig).not.toContain("core.hookspath")
    await writeFile(join(workspace.path, "feature.txt"), "delivered\n")
    git(workspace.path, "add", "feature.txt")
    git(workspace.path, "commit", "-qm", "feature")
    expect(git(workspace.path, "log", "-1", "--format=%cn <%ce>")).toBe(
      "Repository Agent <repository-agent@example.invalid>",
    )

    // Advance the source to force delivery to rebase with the inherited identity.
    await writeFile(join(repo, "main.txt"), "source advance\n")
    git(repo, "add", "main.txt")
    git(repo, "commit", "-qm", "advance source")
    const result = await mergeAndPush(workspace, repo)
    expect(result.ok).toBe(true)
    expect(await readFile(join(repo, "feature.txt"), "utf8")).toBe("delivered\n")
    expect(await readFile(join(repo, "main.txt"), "utf8")).toBe("source advance\n")
  })
})
