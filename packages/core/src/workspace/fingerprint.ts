import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readFile, readlink, realpath } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import { clearedGitEnvironment } from "../util/git-environment"
import { runCommand } from "../workspace/worktree-lifecycle"
import { isActorConfigPath } from "./actor-config"

const HASH_CONCURRENCY = 16
const INLINE_READ_MAX_BYTES = 2 * 1024 * 1024

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

type PreparedEntry =
  | { kind: "deleted"; entry: WorkspaceFileEntry }
  | { kind: "symlink"; mode: number; target: string; entry: WorkspaceFileEntry }
  | { kind: "buffered-file"; mode: number; bytes: Buffer; entry: WorkspaceFileEntry }
  | { kind: "stream-file"; mode: number; path: string }
  | { kind: "other"; mode: number; entry: WorkspaceFileEntry }

/** Hash product files and return both the aggregate workspace fingerprint and per-file entries. */
export async function workspaceFileManifest(
  workspacePath: string,
  excludedPaths: ReadonlySet<string> = new Set(),
): Promise<WorkspaceManifest> {
  const root = await realpath(workspacePath)
  const resolvedWorkspace = resolve(workspacePath)
  const files = await runCommand("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: workspacePath,
    env: clearedGitEnvironment,
  })
  if (files.exitCode !== 0)
    throw new Error(`Cannot inspect mission workspace: ${files.stderr}. Restore its Git metadata before resuming.`)

  const entries: Array<{ name: string; path: string }> = []
  for (const name of [...new Set(files.stdout.split("\0").filter(Boolean))].sort()) {
    if (/^(?:\.agent-valley\/|\.agents\/(?:state|results)\/)/.test(name)) continue
    if (isActorConfigPath(name)) continue
    if (excludedPaths.has(name)) continue
    const path = resolve(workspacePath, name)
    if (!path.startsWith(`${resolvedWorkspace}${sep}`))
      throw new Error("Git returned a path outside the mission workspace")
    entries.push({ name, path })
  }

  // Memoize realpath per unique parent directory to avoid redundant syscalls across files.
  const parentRealpaths = new Map<string, Promise<string>>()
  const resolveParent = (dir: string): Promise<string> => {
    let pending = parentRealpaths.get(dir)
    if (!pending) {
      pending = realpath(dir)
      pending.catch(() => undefined)
      parentRealpaths.set(dir, pending)
    }
    return pending
  }

  const prepareEntry = async (name: string, path: string): Promise<PreparedEntry> => {
    let stat: Awaited<ReturnType<typeof lstat>>
    try {
      stat = await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      const entryHash = createHash("sha256")
      entryHash.update("deleted\0")
      return { kind: "deleted", entry: { sha256: entryHash.digest("hex"), regularNonExec: false } }
    }
    const parent = await resolveParent(dirname(path))
    if (parent !== root && !parent.startsWith(`${root}${sep}`)) {
      throw new Error(
        `Product path ${name} escapes the mission workspace through a directory symlink. Restore that directory before resuming.`,
      )
    }
    if (stat.isDirectory()) {
      throw new Error(
        `Mission contains a submodule at ${name}. Use a repository without submodules for av order; nested product changes cannot yet be verified.`,
      )
    }
    if (stat.isSymbolicLink()) {
      const target = await readlink(path)
      const entryHash = createHash("sha256")
      entryHash.update(`${stat.mode}\0`)
      entryHash.update(`symlink:${target}`)
      entryHash.update("\0")
      return {
        kind: "symlink",
        mode: stat.mode,
        target,
        entry: { sha256: entryHash.digest("hex"), regularNonExec: false },
      }
    }
    if (stat.isFile()) {
      if (stat.size > INLINE_READ_MAX_BYTES) {
        return { kind: "stream-file", mode: stat.mode, path }
      }
      const bytes = await readFile(path)
      const entryHash = createHash("sha256")
      entryHash.update(`${stat.mode}\0`)
      entryHash.update("file:")
      entryHash.update(bytes)
      entryHash.update("\0")
      return {
        kind: "buffered-file",
        mode: stat.mode,
        bytes,
        entry: { sha256: entryHash.digest("hex"), regularNonExec: (stat.mode & 0o111) === 0 },
      }
    }
    const entryHash = createHash("sha256")
    entryHash.update(`${stat.mode}\0`)
    entryHash.update("\0")
    return { kind: "other", mode: stat.mode, entry: { sha256: entryHash.digest("hex"), regularNonExec: false } }
  }

  // Sliding window executes lstat/realpath/readFile in parallel while feeding the aggregate
  // SHA-256 hash in strict sorted path order for a 100% byte-identical fingerprint.
  const hash = createHash("sha256")
  const manifest: Record<string, WorkspaceFileEntry> = {}
  const inFlight = new Map<number, Promise<PreparedEntry>>()
  const schedule = (index: number): void => {
    const item = entries[index]
    if (!item) return
    const task = prepareEntry(item.name, item.path)
    task.catch(() => undefined)
    inFlight.set(index, task)
  }
  const initialWindow = Math.min(HASH_CONCURRENCY, entries.length)
  for (let i = 0; i < initialWindow; i += 1) schedule(i)

  for (let i = 0; i < entries.length; i += 1) {
    const item = entries[i]
    const task = inFlight.get(i)
    if (!item || !task) continue
    const prepared = await task
    inFlight.delete(i)
    schedule(i + HASH_CONCURRENCY)

    hash.update(`${item.name}\0`)
    if (prepared.kind === "deleted") {
      hash.update("deleted\0")
      manifest[item.name] = prepared.entry
      continue
    }
    hash.update(`${prepared.mode}\0`)
    if (prepared.kind === "symlink") {
      hash.update(prepared.target)
      hash.update("\0")
      manifest[item.name] = prepared.entry
    } else if (prepared.kind === "buffered-file") {
      hash.update(prepared.bytes)
      hash.update("\0")
      manifest[item.name] = prepared.entry
    } else if (prepared.kind === "stream-file") {
      const entryHash = createHash("sha256")
      entryHash.update(`${prepared.mode}\0`)
      entryHash.update("file:")
      for await (const chunk of createReadStream(prepared.path)) {
        hash.update(chunk as Buffer)
        entryHash.update(chunk as Buffer)
      }
      hash.update("\0")
      entryHash.update("\0")
      manifest[item.name] = {
        sha256: entryHash.digest("hex"),
        regularNonExec: (prepared.mode & 0o111) === 0,
      }
    } else {
      hash.update("\0")
      manifest[item.name] = prepared.entry
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
