import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { chmod, lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { clearedGitEnvironment } from "../util/git-environment"
import { isActorConfigPath } from "./actor-config"
import {
  fingerprintWorkspace,
  type WorkspaceFileEntry,
  type WorkspaceManifest,
  workspaceFileManifest,
} from "./fingerprint"
import { runCommand } from "./worktree-lifecycle"

const dirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** Reference sequential implementation matching the pre-optimization byte format verbatim. */
async function referenceSequentialManifest(
  workspacePath: string,
  excludedPaths: ReadonlySet<string> = new Set(),
): Promise<WorkspaceManifest> {
  const root = await realpath(workspacePath)
  const files = await runCommand("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: workspacePath,
    env: clearedGitEnvironment,
  })
  if (files.exitCode !== 0) throw new Error(files.stderr)
  const hash = createHash("sha256")
  const manifest: Record<string, WorkspaceFileEntry> = {}
  for (const name of [...new Set(files.stdout.split("\0").filter(Boolean))].sort()) {
    if (/^(?:\.agent-valley\/|\.agents\/(?:state|results)\/)/.test(name)) continue
    if (isActorConfigPath(name)) continue
    if (excludedPaths.has(name)) continue
    const path = resolve(workspacePath, name)
    hash.update(`${name}\0`)
    const entryHash = createHash("sha256")
    let stat: Awaited<ReturnType<typeof lstat>>
    try {
      stat = await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      hash.update("deleted\0")
      entryHash.update("deleted\0")
      manifest[name] = { sha256: entryHash.digest("hex"), regularNonExec: false }
      continue
    }
    const parent = await realpath(dirname(path))
    if (parent !== root && !parent.startsWith(`${root}${sep}`)) {
      throw new Error(`Product path ${name} escapes the mission workspace through a directory symlink.`)
    }
    hash.update(`${stat.mode}\0`)
    entryHash.update(`${stat.mode}\0`)
    if (stat.isSymbolicLink()) {
      const target = await readlink(path)
      hash.update(target)
      entryHash.update(`symlink:${target}`)
    } else if (stat.isFile()) {
      entryHash.update("file:")
      for await (const chunk of createReadStream(path)) {
        hash.update(chunk as Buffer)
        entryHash.update(chunk as Buffer)
      }
    }
    hash.update("\0")
    entryHash.update("\0")
    manifest[name] = {
      sha256: entryHash.digest("hex"),
      regularNonExec: stat.isFile() && (stat.mode & 0o111) === 0,
    }
  }
  return { fingerprint: hash.digest("hex"), files: manifest }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("workspaceFileManifest parallel sliding window", () => {
  it("produces byte-identical fingerprint and per-file entries across small, large, exec, symlink, and deleted files", async () => {
    const repo = await makeTempDir("av-fingerprint-parity-")
    const git = async (...args: string[]) => {
      const res = await runCommand("git", args, { cwd: repo, env: clearedGitEnvironment })
      if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`)
    }
    await git("init", "-q")
    await git("config", "user.email", "test@example.com")
    await git("config", "user.name", "Test")

    // Create 40+ files across shared parent dirs (exercising window > 16 and realpath memoization)
    for (let i = 0; i < 40; i += 1) {
      const subdir = `src/mod-${i % 4}`
      await mkdir(join(repo, subdir), { recursive: true })
      await writeFile(join(repo, subdir, `file-${String(i).padStart(2, "0")}.ts`), `export const n = ${i}\n`)
    }
    // Executable file
    await mkdir(join(repo, "scripts"), { recursive: true })
    await writeFile(join(repo, "scripts/run.sh"), "#!/bin/sh\necho ok\n")
    await chmod(join(repo, "scripts/run.sh"), 0o755)

    // Large file (> 2 MiB) to exercise streaming cursor path
    const largeBuffer = Buffer.alloc(2 * 1024 * 1024 + 65_536, 0x61)
    await writeFile(join(repo, "assets-large.bin"), largeBuffer)

    // Tracked file that will be deleted on disk (ENOENT -> deleted marker)
    await writeFile(join(repo, "removed.txt"), "will be removed\n")

    // Internal symlink
    await symlink("src/mod-0/file-00.ts", join(repo, "link-to-file.ts"))

    // Excluded / ignored runtime paths
    await mkdir(join(repo, ".agent-valley"), { recursive: true })
    await writeFile(join(repo, ".agent-valley/state.json"), "{}")
    await writeFile(join(repo, "excluded.txt"), "skip me\n")

    await git("add", "-A")
    await git("commit", "-q", "-m", "initial")
    await unlink(join(repo, "removed.txt"))
    await writeFile(join(repo, "untracked.txt"), "fresh untracked\n")

    const excluded = new Set(["excluded.txt"])
    const expected = await referenceSequentialManifest(repo, excluded)
    const actual = await workspaceFileManifest(repo, excluded)

    expect(actual.fingerprint).toBe(expected.fingerprint)
    expect(actual.files).toEqual(expected.files)
    expect(await fingerprintWorkspace(repo, excluded)).toBe(expected.fingerprint)
    expect(actual.files["scripts/run.sh"]?.regularNonExec).toBe(false)
    expect(actual.files["link-to-file.ts"]?.regularNonExec).toBe(false)
    expect(actual.files["removed.txt"]?.regularNonExec).toBe(false)
    expect(actual.files["assets-large.bin"]?.regularNonExec).toBe(true)
    expect(actual.files["excluded.txt"]).toBeUndefined()
  })

  it("rejects directory symlink escapes deterministically without unhandled rejections", async () => {
    const outside = await makeTempDir("av-fingerprint-outside-")
    await writeFile(join(outside, "secret.txt"), "outside\n")

    const repo = await makeTempDir("av-fingerprint-escape-")
    const git = async (...args: string[]) => {
      const res = await runCommand("git", args, { cwd: repo, env: clearedGitEnvironment })
      if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`)
    }
    await git("init", "-q")
    await git("config", "user.email", "test@example.com")
    await git("config", "user.name", "Test")
    await mkdir(join(repo, "dir"), { recursive: true })
    await writeFile(join(repo, "dir/secret.txt"), "inside\n")
    await writeFile(join(repo, "z-last.txt"), "last\n")
    await git("add", "-A")
    await git("commit", "-q", "-m", "init")

    // Replace tracked directory with symlink escaping the workspace
    await rm(join(repo, "dir"), { recursive: true, force: true })
    await symlink(outside, join(repo, "dir"), "dir")

    await expect(workspaceFileManifest(repo)).rejects.toThrow(
      /escapes the mission workspace through a directory symlink/,
    )
  })
})
