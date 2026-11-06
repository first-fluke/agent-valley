import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { A2aJobStore } from "../executions/a2a-store"
import { ensureRuntimeGitignore, prepareRuntimeGitignore } from "../workspace/runtime-ignore"

const execute = promisify(execFile)
let directory: string
let repository: string

async function git(args: string[], cwd = repository) {
  return execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd })
}

async function ignored(path = ".agent-valley/state.db", cwd = repository): Promise<boolean> {
  try {
    await git(["check-ignore", "--no-index", "--quiet", "--", path], cwd)
    return true
  } catch (error) {
    if ((error as { code?: number | string }).code === 1) return false
    throw error
  }
}

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "av-runtime-ignore-")))
  repository = join(directory, "repository")
  await mkdir(repository)
  await git(["init", "-q"])
  await git(["config", "user.name", "AV test"])
  await git(["config", "user.email", "av-test@example.invalid"])
})

describe("A2A runtime startup exclusion", () => {
  it("excludes the A2A lock and records when mutating execution starts", async () => {
    const store = new A2aJobStore(repository)
    const unlock = await store.lock()
    try {
      expect(await ignored(".agent-valley/a2a/repository.lock")).toBe(true)
      expect((await lstat(join(repository, ".agent-valley", "a2a", "repository.lock"))).isFile()).toBe(true)
      expect(await readFile(join(repository, ".gitignore"), "utf8")).toBe(".agent-valley/\n")
    } finally {
      await unlock()
    }
  })

  it("rejects an unsafe ignore file before creating execution metadata", async () => {
    const target = join(directory, "private-ignore")
    const original = "# Keep the external target unchanged\n"
    await writeFile(target, original)
    await symlink(target, join(repository, ".gitignore"))
    const store = new A2aJobStore(repository)

    await expect(store.lock()).rejects.toThrow(/\.gitignore/)

    await expect(lstat(join(repository, ".agent-valley"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(target, "utf8")).toBe(original)
  })

  it("does not create a project ignore file during status listing or record reads", async () => {
    const store = new A2aJobStore(repository)

    await expect(store.list()).resolves.toEqual([])
    await expect(store.load(randomUUID())).rejects.toMatchObject({ code: "ENOENT" })

    await expect(lstat(join(repository, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await ignored(".agent-valley/a2a/repository.lock")).toBe(false)
  })
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true, maxRetries: 3 })
})

describe("project runtime Git exclusion", () => {
  it("plans the canonical rule without changing project files", async () => {
    const path = join(repository, ".gitignore")
    const before = "# Keep project rules\n*.log"
    await writeFile(path, before)

    expect(await prepareRuntimeGitignore(repository)).toMatchObject({
      path,
      before,
      after: `${before}\n.agent-valley/\n`,
    })
    expect(await readFile(path, "utf8")).toBe(before)
    expect(await ignored()).toBe(false)
  })

  it("creates a project .gitignore that Git actually applies to runtime records", async () => {
    await mkdir(join(repository, ".agent-valley"))
    await writeFile(join(repository, ".agent-valley", "state.db"), "runtime fixture")

    await expect(ensureRuntimeGitignore(repository)).resolves.toBe(true)

    expect(await readFile(join(repository, ".gitignore"), "utf8")).toBe(".agent-valley/\n")
    expect(await ignored()).toBe(true)
    expect((await git(["status", "--porcelain", "--", ".agent-valley"])).stdout).toBe("")
  })

  it("preserves comments and patterns when the original last line has no newline", async () => {
    const path = join(repository, ".gitignore")
    const before = "# User configuration\nnode_modules/\n!important.log"
    await writeFile(path, before)

    await ensureRuntimeGitignore(repository)

    expect(await readFile(path, "utf8")).toBe(`${before}\n.agent-valley/\n`)
    expect(await ignored()).toBe(true)
  })

  it("retains CRLF bytes when appending the runtime rule", async () => {
    const path = join(repository, ".gitignore")
    const before = "# User configuration\r\n*.log\r\n"
    await writeFile(path, before)

    await ensureRuntimeGitignore(repository)

    expect(await readFile(path, "utf8")).toBe(`${before}.agent-valley/\r\n`)
    expect(await ignored()).toBe(true)
  })

  it("does not mistake a comment or similarly named file for the directory exclusion", async () => {
    const path = join(repository, ".gitignore")
    const before = "# .agent-valley stores local metadata\n.agent-valley-plugins.json\n"
    await writeFile(path, before)

    await expect(ensureRuntimeGitignore(repository)).resolves.toBe(true)

    expect(await readFile(path, "utf8")).toBe(`${before}.agent-valley/\n`)
    expect(await ignored()).toBe(true)
  })

  it("appends after a later negation and does not append again once the rule is effective", async () => {
    const path = join(repository, ".gitignore")
    const before = "# Existing runtime rules\n.agent-valley/\n!.agent-valley/\n"
    await writeFile(path, before)
    expect(await ignored()).toBe(false)

    await expect(ensureRuntimeGitignore(repository)).resolves.toBe(true)
    const after = await readFile(path, "utf8")
    expect(after).toBe(`${before}.agent-valley/\n`)
    expect(await ignored()).toBe(true)
    await expect(ensureRuntimeGitignore(repository)).resolves.toBe(false)
    expect(await readFile(path, "utf8")).toBe(after)
    await expect(prepareRuntimeGitignore(repository)).resolves.toBeUndefined()
  })

  it("keeps an already effective canonical rule and its surrounding bytes unchanged", async () => {
    const path = join(repository, ".gitignore")
    const before = "# Existing configuration\n.agent-valley/\n*.log\n"
    await writeFile(path, before)

    await expect(ensureRuntimeGitignore(repository)).resolves.toBe(false)

    expect(await readFile(path, "utf8")).toBe(before)
    expect(await ignored()).toBe(true)
  })

  it("adds the runtime rule inside a nested metadata root without changing the enclosing project", async () => {
    const nested = join(repository, "configuration")
    await mkdir(nested)

    await expect(prepareRuntimeGitignore(nested)).resolves.toMatchObject({
      path: join(nested, ".gitignore"),
      before: null,
      after: ".agent-valley/\n",
    })

    await ensureRuntimeGitignore(nested)

    expect(await readFile(join(nested, ".gitignore"), "utf8")).toBe(".agent-valley/\n")
    await expect(lstat(join(repository, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await ignored(".agent-valley/state.db", nested)).toBe(true)
  })

  it("overrides a nested re-inclusion even when the enclosing project already excludes runtime directories", async () => {
    const rootIgnore = "# Root project rules\n.agent-valley/\n"
    await writeFile(join(repository, ".gitignore"), rootIgnore)
    const nested = join(repository, "configuration")
    await mkdir(nested)
    const before = "# Local project rules\n!.agent-valley/\n"
    await writeFile(join(nested, ".gitignore"), before)
    expect(await ignored(".agent-valley/state.db", nested)).toBe(false)

    await expect(ensureRuntimeGitignore(nested)).resolves.toBe(true)

    expect(await readFile(join(repository, ".gitignore"), "utf8")).toBe(rootIgnore)
    expect(await readFile(join(nested, ".gitignore"), "utf8")).toBe(`${before}.agent-valley/\n`)
    expect(await ignored(".agent-valley/state.db", nested)).toBe(true)
    await expect(ensureRuntimeGitignore(nested)).resolves.toBe(false)
  })

  it("supports a linked worktree without changing the original checkout's ignore file", async () => {
    await writeFile(join(repository, "source.txt"), "source fixture")
    await git(["add", "source.txt"])
    await git(["commit", "-qm", "Fixture baseline"])
    const workspace = join(directory, "worktree")
    await git(["worktree", "add", "--detach", workspace])
    expect((await lstat(join(workspace, ".git"))).isFile()).toBe(true)

    await ensureRuntimeGitignore(workspace)

    expect(await readFile(join(workspace, ".gitignore"), "utf8")).toBe(".agent-valley/\n")
    expect(await ignored(".agent-valley/state.db", workspace)).toBe(true)
    await expect(lstat(join(repository, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("leaves a non-Git directory untouched", async () => {
    const outside = join(directory, "outside")
    await mkdir(outside)

    await expect(ensureRuntimeGitignore(outside)).resolves.toBe(false)
    await expect(prepareRuntimeGitignore(outside)).resolves.toBeUndefined()

    await expect(lstat(join(outside, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects .gitignore symlinks without writing through their targets", async () => {
    const target = join(directory, "private-ignore")
    const original = "# Keep the external target unchanged\n"
    await writeFile(target, original)
    await symlink(target, join(repository, ".gitignore"))

    await expect(ensureRuntimeGitignore(repository)).rejects.toThrow(/\.gitignore/)

    expect(await readFile(target, "utf8")).toBe(original)
    expect((await lstat(join(repository, ".gitignore"))).isSymbolicLink()).toBe(true)
  })

  it("rejects a read-only ignore file rather than replacing its rules", async () => {
    const path = join(repository, ".gitignore")
    const original = "# Managed by the project\n*.log\n"
    await writeFile(path, original)
    await chmod(path, 0o444)

    await expect(ensureRuntimeGitignore(repository)).rejects.toThrow(/\.gitignore/)

    expect(await readFile(path, "utf8")).toBe(original)
    expect((await lstat(path)).mode & 0o777).toBe(0o444)
  })
})
