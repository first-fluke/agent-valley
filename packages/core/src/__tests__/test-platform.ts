import { copyFile, lstat, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"

export const isWindows = process.platform === "win32"

/**
 * Creates a reparse point without requiring Windows Developer Mode. Junctions report
 * `isSymbolicLink()` on Windows and preserve the escape semantics these tests exercise.
 */
export async function makeSymlink(target: string, path: string): Promise<void> {
  if (!isWindows) return symlink(target, path)
  const absolute = isAbsolute(target) ? target : resolve(dirname(path), target)
  const existing = await lstat(absolute).catch(() => undefined)
  if (existing?.isDirectory()) return symlink(absolute, path, "junction")
  const directory = await mkdtemp(join(tmpdir(), "av-link-target-"))
  const copy = join(directory, basename(absolute))
  if (existing) await copyFile(absolute, copy)
  else await writeFile(copy, "")
  await symlink(directory, path, "junction")
}

/** POSIX permission bits and the executable bit are not enforced on Windows filesystems. */
export const supportsPosixModes = !isWindows

/** Windows filenames reject the glob metacharacters * and ? as well as the pathspec colon. */
export const supportsLiteralGlobNames = !isWindows

/** Windows tooling does not round-trip control characters such as newlines in file names. */
export const supportsNewlineFilenames = !isWindows
