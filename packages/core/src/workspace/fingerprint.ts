import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readlink, realpath } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import { clearedGitEnvironment } from "../util/git-environment"
import { runCommand } from "../workspace/worktree-lifecycle"
import { isActorConfigPath } from "./actor-config"

export interface WorkspaceFileEntry {
  /** SHA-256 of mode and symlink target, file contents, or deletion marker. */
  sha256: string
  /** True only for non-executable regular files (never symlinks, executables, or deleted paths). */
  regularNonExec: boolean
}

export interface WorkspaceManifest {
  fingerprint: string
  files: Record<string, WorkspaceFileEntry>
}

/** Hash product files and return both the aggregate workspace fingerprint and per-file entries. */
export async function workspaceFileManifest(
  workspacePath: string,
  excludedPaths: ReadonlySet<string> = new Set(),
): Promise<WorkspaceManifest> {
  const root = await realpath(workspacePath)
  const files = await runCommand("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: workspacePath,
    env: clearedGitEnvironment,
  })
  if (files.exitCode !== 0)
    throw new Error(`Cannot inspect mission workspace: ${files.stderr}. Restore its Git metadata before resuming.`)
  const hash = createHash("sha256")
  const manifest: Record<string, WorkspaceFileEntry> = {}
  for (const name of [...new Set(files.stdout.split("\0").filter(Boolean))].sort()) {
    if (/^(?:\.agent-valley\/|\.agents\/(?:state|results)\/)/.test(name)) continue
    if (isActorConfigPath(name)) continue
    if (excludedPaths.has(name)) continue
    const path = resolve(workspacePath, name)
    if (!path.startsWith(`${resolve(workspacePath)}${sep}`))
      throw new Error("Git returned a path outside the mission workspace")
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
      throw new Error(
        `Product path ${name} escapes the mission workspace through a directory symlink. Restore that directory before resuming.`,
      )
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
    } else if (stat.isDirectory()) {
      throw new Error(
        `Mission contains a submodule at ${name}. Use a repository without submodules for av order; nested product changes cannot yet be verified.`,
      )
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

/** Hash product files, including untracked deliverables, without commit timestamps or run receipts. */
export async function fingerprintWorkspace(
  workspacePath: string,
  excludedPaths: ReadonlySet<string> = new Set(),
): Promise<string> {
  return (await workspaceFileManifest(workspacePath, excludedPaths)).fingerprint
}
