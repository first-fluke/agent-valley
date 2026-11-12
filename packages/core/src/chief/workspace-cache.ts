import { execFile } from "node:child_process"
import { lstat, mkdir, readdir, rename, rm, rmdir } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import { promisify } from "node:util"
import { clearedGitEnvironment } from "../util/git-environment"
import { readContinuousMissionWorkspace } from "./continuous-workspace"

const exec = promisify(execFile)
const CLONE_TIMEOUT_MS = 180_000
const PRUNE_TIMEOUT_MS = 120_000
export const WORKSPACE_CACHE_ENV = "AV_WORKSPACE_CACHE_PATHS"
const disabled = new Set(["0", "off", "none", "false"])

export interface CacheSeed {
  path: string
  source: string
}
export type CloneTree = (source: string, destination: string) => Promise<void>

function validCachePath(path: string): boolean {
  if (!path || isAbsolute(path)) return false
  const parts = path.split("/")
  const reserved = parts[0] === ".git" || parts[0] === ".agent-valley"
  return !reserved && parts.every((part) => part && part !== "." && part !== "..")
}

/**
 * Regenerable build output worth carrying into a fresh workspace. `AV_WORKSPACE_CACHE_PATHS` lists
 * repository-relative directories (comma separated) or disables seeding with `off`; unset, a Cargo
 * workspace seeds its debug and release profiles. Instrumented coverage output is left out on purpose.
 */
export async function workspaceCachePaths(
  workspace: string,
  configured: string | undefined = process.env[WORKSPACE_CACHE_ENV],
): Promise<string[]> {
  if (configured !== undefined) {
    const value = configured.trim()
    if (!value || disabled.has(value.toLowerCase())) return []
    const entries = value.split(",").map((entry) => entry.trim().replace(/\/+$/, ""))
    return [...new Set(entries.filter(validCachePath))]
  }
  const cargo = await lstat(join(workspace, "Cargo.toml")).catch(() => undefined)
  return cargo?.isFile() ? ["target/debug", "target/release"] : []
}

/** The volume holding `path` is APFS, read from the mount table entry of its device. */
async function onApfs(path: string): Promise<boolean> {
  const device = (await exec("/bin/df", ["-P", path])).stdout.trim().split("\n").at(-1)?.split(/\s+/)[0]
  if (!device) return false
  const mounts = (await exec("/sbin/mount")).stdout.split("\n")
  return mounts.some((line) => line.startsWith(`${device} on `) && /\(apfs[,)]/.test(line))
}

/** Clone a directory tree without duplicating data blocks; throws when the volume cannot do that. */
export async function copyOnWriteClone(source: string, destination: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? { program: "/bin/cp", args: ["-c", "-R", "-p"] }
      : process.platform === "linux"
        ? { program: "cp", args: ["--reflink=always", "-R", "-p"] }
        : undefined
  if (!command) throw new Error(`Copy-on-write cloning is unavailable on ${process.platform}.`)
  const [from, to] = await Promise.all([lstat(source), lstat(dirname(destination))])
  if (from.dev !== to.dev) throw new Error("Copy-on-write cloning needs the source and destination on one volume.")
  // macOS cp silently falls back to a full copy when cloning is unsupported; require APFS before a large tree.
  if (process.platform === "darwin" && !(await onApfs(dirname(destination))))
    throw new Error("Copy-on-write cloning needs an APFS volume.")
  await exec(command.program, [...command.args, source, destination], { timeout: CLONE_TIMEOUT_MS })
}

/** Only ignored directories may be seeded: anything Git can see would become part of a task delivery. */
async function ignoredDirectory(workspace: string, path: string): Promise<boolean> {
  const destination = join(workspace, path)
  // Directory-only ignore rules match a path only once it exists as a directory.
  await mkdir(destination, { recursive: true })
  try {
    await exec("git", ["check-ignore", "-q", "--", path], {
      cwd: workspace,
      env: { ...process.env, ...clearedGitEnvironment },
    })
    return true
  } catch {
    return false
  } finally {
    await rmdir(destination).catch(() => undefined)
  }
}

/**
 * Seed missing build caches of a new workspace from the first source that has them. A cold workspace
 * otherwise rebuilds every dependency per task attempt. Stale entries are harmless: the build tool
 * revalidates its own cache. Seeding never fails workspace preparation.
 */
export async function seedWorkspaceCaches(options: {
  workspace: string
  /** Candidate workspaces, most preferred first. */
  sources: readonly string[]
  paths?: readonly string[]
  clone?: CloneTree
  prune?: (workspace: string) => Promise<void>
}): Promise<CacheSeed[]> {
  const seeded: CacheSeed[] = []
  try {
    const paths = options.paths ?? (await workspaceCachePaths(options.workspace))
    for (const path of paths) {
      const destination = join(options.workspace, path)
      if (await lstat(destination).catch(() => undefined)) continue
      const sources: string[] = []
      for (const source of options.sources)
        if ((await lstat(join(source, path)).catch(() => undefined))?.isDirectory()) sources.push(source)
      const source = sources[0]
      if (!source || !(await ignoredDirectory(options.workspace, path))) continue
      try {
        await mkdir(dirname(destination), { recursive: true })
        await (options.clone ?? copyOnWriteClone)(join(source, path), destination)
        seeded.push({ path, source })
      } catch {
        await rm(destination, { recursive: true, force: true })
      }
    }
    if (seeded.length) await (options.prune ?? pruneCarriedArtifacts)(options.workspace).catch(() => undefined)
  } catch {
    // A cache is an optimization; the workspace stays usable without it.
  }
  return seeded
}

/**
 * A cloned Cargo cache still holds the source workspace's own crates, which the new path can never reuse.
 * Dropping them keeps only dependency builds, so the cache does not grow with every workspace it passes through.
 */
export async function pruneCarriedArtifacts(workspace: string): Promise<void> {
  if (!(await lstat(join(workspace, "Cargo.toml")).catch(() => undefined))?.isFile()) return
  await exec("cargo", ["clean", "--workspace", "--offline", "--quiet"], {
    cwd: workspace,
    timeout: PRUNE_TIMEOUT_MS,
    env: { ...process.env, CARGO_NET_OFFLINE: "true" },
  })
}

/** Where one operation keeps the build caches of its latest completed child, laid out like a workspace. */
export async function operationCacheStore(workspace: string): Promise<string | undefined> {
  const container = dirname(workspace)
  const record = await readContinuousMissionWorkspace(container).catch(() => undefined)
  return record?.path === workspace ? join(dirname(dirname(container)), "build-cache") : undefined
}

/**
 * Move a finished workspace's build caches into `store` instead of deleting them, replacing the previous
 * copy. A rename costs nothing on one volume and bounds the cache to one copy per operation.
 */
export async function retainWorkspaceCaches(
  workspace: string,
  store: string,
  paths?: readonly string[],
): Promise<string[]> {
  const retained: string[] = []
  try {
    for (const path of paths ?? (await workspaceCachePaths(workspace))) {
      const source = join(workspace, path)
      if (!(await lstat(source).catch(() => undefined))?.isDirectory()) continue
      const destination = join(store, path)
      try {
        await mkdir(dirname(destination), { recursive: true })
        await rm(destination, { recursive: true, force: true })
        await rename(source, destination)
        retained.push(path)
      } catch {
        // Another volume or a busy directory: leave it for the ordinary build-output release.
      }
    }
  } catch {
    // Retaining a cache is an optimization; storage release continues without it.
  }
  return retained
}

/** Other mission workspaces of one operation, newest first, as cache sources for a new mission. */
export async function siblingMissionWorkspaces(workspace: string): Promise<string[]> {
  const container = dirname(workspace)
  const parent = dirname(container)
  const names = await readdir(parent).catch(() => [] as string[])
  const siblings: { path: string; at: number }[] = []
  for (const name of names) {
    const directory = join(parent, name)
    if (directory === container) continue
    const record = await lstat(join(directory, "workspace.json")).catch(() => undefined)
    if (record?.isFile()) siblings.push({ path: join(directory, "workspace"), at: record.mtimeMs })
  }
  return siblings.sort((a, b) => b.at - a.at).map((entry) => entry.path)
}
