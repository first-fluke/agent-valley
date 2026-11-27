import { execFile } from "node:child_process"
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import { promisify } from "node:util"
import { clearedGitEnvironment } from "../util/git-environment"
import { readContinuousMissionWorkspace } from "./continuous-workspace"

const exec = promisify(execFile)
const CLONE_TIMEOUT_MS = 180_000
const PRUNE_TIMEOUT_MS = 120_000
const CARGO_METADATA_MAX_BUFFER = 16 * 1024 * 1024
const CARGO_PROFILES = ["debug", "release"] as const
const CARGO_ARTIFACT_DIRS = ["deps", "examples"] as const
const CARGO_HASHED_ARTIFACT = /^([A-Za-z0-9_-]+)-[a-f0-9]{16}(?:$|\.)/
export const WORKSPACE_CACHE_ENV = "AV_WORKSPACE_CACHE_PATHS"
const disabled = new Set(["0", "off", "none", "false"])

export interface CacheSeed {
  path: string
  source: string
}
export type CloneTree = (source: string, destination: string) => Promise<void>
export interface PruneCargoOptions {
  runCargoClean?: (workspace: string) => Promise<void>
  discoverWorkspaceIdents?: (workspace: string) => Promise<ReadonlySet<string>>
}

function isCargoProfilePath(path: string): boolean {
  return path.startsWith("target/") && (path.endsWith("/debug") || path.endsWith("/release"))
}

function isCargoTargetPath(path: string): boolean {
  return path === "target" || path.startsWith("target/")
}

async function cloneCargoProfileWithoutIncremental(
  sourceDir: string,
  destinationDir: string,
  clone: CloneTree,
): Promise<void> {
  await mkdir(destinationDir, { recursive: true })
  const entries = await readdir(sourceDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.name === "incremental") continue
    const entrySource = join(sourceDir, entry.name)
    // Skip entries that vanished between readdir and clone (e.g. transient lock files).
    if (!(await lstat(entrySource).catch(() => undefined))) continue
    await clone(entrySource, join(destinationDir, entry.name))
  }
}

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
  const paths: string[] = []
  const cargo = await lstat(join(workspace, "Cargo.toml")).catch(() => undefined)
  if (cargo?.isFile()) paths.push("target/debug", "target/release")
  const nodeCaches = await jsWorkspaceCachePaths(workspace)
  paths.push(...nodeCaches)
  return [...new Set(paths.filter(validCachePath))]
}

async function jsWorkspaceCachePaths(workspace: string): Promise<string[]> {
  const manifestPath = join(workspace, "package.json")
  const manifestStat = await lstat(manifestPath).catch(() => undefined)
  if (!manifestStat?.isFile() || manifestStat.size > 256_000) return []
  const caches = ["node_modules"]
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as {
      workspaces?: unknown
    }
    const rawPatterns = Array.isArray(parsed.workspaces)
      ? parsed.workspaces
      : parsed.workspaces &&
          typeof parsed.workspaces === "object" &&
          Array.isArray((parsed.workspaces as { packages?: unknown }).packages)
        ? (parsed.workspaces as { packages: unknown[] }).packages
        : []
    for (const pattern of rawPatterns) {
      if (typeof pattern !== "string") continue
      const normalized = pattern.trim().replace(/\/+/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")
      if (!normalized || normalized.startsWith("!")) continue
      if (normalized.endsWith("/*")) {
        const prefix = normalized.slice(0, -2)
        if (!validCachePath(prefix)) continue
        const entries = await readdir(join(workspace, prefix), { withFileTypes: true }).catch(() => [])
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const memberPkg = await lstat(join(workspace, prefix, entry.name, "package.json")).catch(() => undefined)
          if (memberPkg?.isFile()) caches.push(`${prefix}/${entry.name}/node_modules`)
        }
      } else if (!normalized.includes("*") && validCachePath(normalized)) {
        const memberPkg = await lstat(join(workspace, normalized, "package.json")).catch(() => undefined)
        if (memberPkg?.isFile()) caches.push(`${normalized}/node_modules`)
      }
    }
  } catch {
    // Malformed package.json still keeps root node_modules seeding safe.
  }
  return caches
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
 * revalidates its own cache. Seeding never fails workspace preparation. A `handover` source gives its
 * directory away; any other source keeps it and the workspace gets a copy-on-write clone.
 */
export async function seedWorkspaceCaches(options: {
  workspace: string
  /** Candidate workspaces, most preferred first. */
  sources: readonly string[]
  paths?: readonly string[]
  /**
   * Sources that only hold a cache for the next workspace. Their directory is moved, not cloned: a clone
   * left in place stops sharing blocks as soon as the new workspace rebuilds, and one operation then kept
   * 26 GB of unused build output beside a 70 GB workspace until the volume ran out during a check.
   */
  handover?: readonly string[]
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
        const moved =
          options.handover?.includes(source) &&
          (await rename(join(source, path), destination).then(
            () => true,
            () => false,
          ))
        if (moved) {
          // Strip incremental caches even on handover in case an older unpruned build-cache contained them.
          if (isCargoProfilePath(path)) {
            await rm(join(destination, "incremental"), { recursive: true, force: true }).catch(() => undefined)
          } else if (path === "target") {
            for (const profile of CARGO_PROFILES) {
              await rm(join(destination, profile, "incremental"), { recursive: true, force: true }).catch(
                () => undefined,
              )
            }
          }
        } else if (isCargoProfilePath(path)) {
          await cloneCargoProfileWithoutIncremental(join(source, path), destination, options.clone ?? copyOnWriteClone)
        } else {
          await (options.clone ?? copyOnWriteClone)(join(source, path), destination)
        }
        seeded.push({ path, source })
      } catch {
        await rm(destination, { recursive: true, force: true })
      }
    }
    if (seeded.some((entry) => isCargoTargetPath(entry.path)))
      await (options.prune ?? pruneCarriedArtifacts)(options.workspace).catch(() => undefined)
  } catch {
    // A cache is an optimization; the workspace stays usable without it.
  }
  return seeded
}

/** Discover normalized Cargo crate and target identifiers owned by the workspace itself. */
export async function discoverCargoWorkspaceIdentifiers(workspace: string): Promise<Set<string>> {
  const identifiers = new Set<string>()
  try {
    const { stdout } = await exec("cargo", ["metadata", "--no-deps", "--offline", "--format-version", "1"], {
      cwd: workspace,
      timeout: PRUNE_TIMEOUT_MS,
      maxBuffer: CARGO_METADATA_MAX_BUFFER,
      env: { ...process.env, CARGO_NET_OFFLINE: "true" },
    })
    const parsed = JSON.parse(stdout) as {
      packages?: Array<{ name?: unknown; targets?: Array<{ name?: unknown }> }>
    }
    for (const pkg of parsed.packages ?? []) {
      if (typeof pkg.name === "string" && pkg.name.trim()) identifiers.add(pkg.name.trim().replace(/-/g, "_"))
      for (const target of pkg.targets ?? []) {
        if (typeof target.name === "string" && target.name.trim())
          identifiers.add(target.name.trim().replace(/-/g, "_"))
      }
    }
  } catch {
    // Metadata lookup is best-effort; never fail workspace preparation or cache retention.
  }
  return identifiers
}

function isWorkspaceOwnedCargoArtifact(filename: string, workspaceIdents: ReadonlySet<string>): boolean {
  const match = CARGO_HASHED_ARTIFACT.exec(filename)
  if (!match?.[1]) return false
  const stem = match[1].replace(/-/g, "_")
  return workspaceIdents.has(stem) || (stem.startsWith("lib") && workspaceIdents.has(stem.slice(3)))
}

/**
 * A cloned Cargo cache still holds the source workspace's own crates, path-bound incremental caches, and
 * historical hash-suffixed `.rcgu.o` / test binaries that `cargo clean --workspace` leaves behind.
 * Dropping them keeps only third-party dependency builds, so the cache does not grow across cycles.
 */
export async function pruneCarriedArtifacts(workspace: string, options?: PruneCargoOptions): Promise<void> {
  if (!(await lstat(join(workspace, "Cargo.toml")).catch(() => undefined))?.isFile()) return
  // 1. Remove path-bound rustc incremental caches (never hit after moving/cloning to another workspace path).
  for (const profile of CARGO_PROFILES) {
    await rm(join(workspace, "target", profile, "incremental"), { recursive: true, force: true }).catch(() => undefined)
  }
  // 2. Clean current-hash workspace outputs via Cargo.
  try {
    if (options?.runCargoClean) {
      await options.runCargoClean(workspace)
    } else {
      await exec("cargo", ["clean", "--workspace", "--offline", "--quiet"], {
        cwd: workspace,
        timeout: PRUNE_TIMEOUT_MS,
        env: { ...process.env, CARGO_NET_OFFLINE: "true" },
      })
    }
  } catch {
    // Continue to stale workspace artifact pruning even if cargo clean fails or is unavailable.
  }
  // 3. Prune historical workspace-owned artifacts in deps/ and examples/ that cargo clean misses.
  const workspaceIdents = options?.discoverWorkspaceIdents
    ? await options.discoverWorkspaceIdents(workspace).catch(() => new Set<string>())
    : await discoverCargoWorkspaceIdentifiers(workspace)
  if (workspaceIdents.size === 0) return
  for (const profile of CARGO_PROFILES) {
    for (const subdir of CARGO_ARTIFACT_DIRS) {
      const directory = join(workspace, "target", profile, subdir)
      const entries = await readdir(directory).catch(() => [] as string[])
      for (const entry of entries) {
        if (!isWorkspaceOwnedCargoArtifact(entry, workspaceIdents)) continue
        await rm(join(directory, entry), { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }
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
  options?: { prune?: (workspace: string) => Promise<void> },
): Promise<string[]> {
  const retained: string[] = []
  try {
    const resolved = paths ?? (await workspaceCachePaths(workspace))
    let hasCargoCacheDir = false
    for (const path of resolved) {
      if (isCargoTargetPath(path) && (await lstat(join(workspace, path)).catch(() => undefined))?.isDirectory()) {
        hasCargoCacheDir = true
        break
      }
    }
    if (hasCargoCacheDir && (await lstat(join(workspace, "Cargo.toml")).catch(() => undefined))?.isFile()) {
      await (options?.prune ?? pruneCarriedArtifacts)(workspace).catch(() => undefined)
    }
    for (const path of resolved) {
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
