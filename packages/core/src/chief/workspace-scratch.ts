import { execFile } from "node:child_process"
import { lstat, readdir, realpath, rm } from "node:fs/promises"
import { isAbsolute, join, normalize, sep } from "node:path"

export const WORKSPACE_SCRATCH_ENV = "AV_WORKSPACE_SCRATCH"
export const WORKSPACE_SCRATCH_MINUTES_ENV = "AV_WORKSPACE_SCRATCH_MINUTES"
export const DEFAULT_WORKSPACE_SCRATCH_MINUTES = 30

export interface ScratchRelease {
  /** Entries of earlier runs that were removed, per declared directory. */
  cleared: Array<{ directory: string; entries: number }>
  /** Declared directories AV refused to touch, each with the reason. */
  skipped: Array<{ directory: string; reason: string }>
}

const ignored = (workspace: string, directory: string) =>
  new Promise<boolean>((resolve) => {
    execFile("git", ["-C", workspace, "check-ignore", "-q", "--", directory], { timeout: 20_000 }, (error) =>
      resolve(!error),
    )
  })

/** Workspace-relative directories the operator declared as test or build scratch, separated by commas or lines. */
export function scratchDirectories(env: Record<string, string | undefined> = process.env): string[] {
  return [
    ...new Set(
      (env[WORKSPACE_SCRATCH_ENV] ?? "")
        .split(/[,\n]/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ]
}

function scratchAgeMs(env: Record<string, string | undefined>): number {
  const raw = env[WORKSPACE_SCRATCH_MINUTES_ENV]?.trim()
  const minutes = raw ? Number(raw) : DEFAULT_WORKSPACE_SCRATCH_MINUTES
  return (Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_WORKSPACE_SCRATCH_MINUTES) * 60_000
}

/**
 * Tests that leave per-run fixture directories behind used to fill a mission workspace: one project wrote
 * 2.6 GiB per test run and reached 74 GiB in a day. AV cannot tell such scratch from a build cache or from
 * evidence, so the operator names the directories and AV empties them of earlier runs before each check and
 * before verification. Entries newer than the age bound stay, so the latest run remains inspectable.
 * Only Git-ignored directories inside the workspace are touched, and a refusal never blocks the check.
 */
export async function releaseWorkspaceScratch(
  workspace: string,
  env: Record<string, string | undefined> = process.env,
  now: number = Date.now(),
): Promise<ScratchRelease> {
  const result: ScratchRelease = { cleared: [], skipped: [] }
  const directories = scratchDirectories(env)
  if (!directories.length) return result
  const limit = now - scratchAgeMs(env)
  const root = await realpath(workspace)
  for (const directory of directories) {
    const skip = (reason: string) => result.skipped.push({ directory, reason })
    const relative = normalize(directory)
    const first = relative.split(sep)[0]
    if (isAbsolute(directory) || relative === "." || first === ".." || first === ".git" || first === ".agent-valley") {
      skip("it is not a directory inside the workspace's own files; use a workspace-relative path")
      continue
    }
    const path = join(root, relative)
    try {
      if (!(await lstat(path)).isDirectory() || (await realpath(path)) !== path) {
        skip("it is not a plain directory (a symbolic link is never followed)")
        continue
      }
    } catch {
      continue // Nothing has been written there yet.
    }
    if (!(await ignored(root, relative))) {
      skip("it is not Git-ignored; AV clears only ignored output, never tracked or untracked product files")
      continue
    }
    let entries = 0
    for (const name of await readdir(path)) {
      const child = join(path, name)
      try {
        if ((await lstat(child)).mtimeMs >= limit) continue
        await rm(child, { recursive: true, force: true })
        entries += 1
      } catch {
        // An entry that vanished or cannot be removed stays for the next pass.
      }
    }
    if (entries) result.cleared.push({ directory: relative, entries })
  }
  return result
}

/** One line for the check result; undefined when nothing was cleared or refused. */
export function scratchNote(release: ScratchRelease): string | undefined {
  const parts = [
    ...release.cleared.map((entry) => `AV cleared ${entry.entries} entries of earlier runs from ${entry.directory}.`),
    ...release.skipped.map(
      (entry) => `${WORKSPACE_SCRATCH_ENV} entry ${entry.directory} was not cleared: ${entry.reason}.`,
    ),
  ]
  return parts.length ? `Storage: ${parts.join(" ")}` : undefined
}
