import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const isWindows = process.platform === "win32"

/** Windows requires Developer Mode or elevation to create file symlinks. */
export const supportsFileSymlinks = (() => {
  if (!isWindows) return true
  const root = mkdtempSync(join(tmpdir(), "av-symlink-probe-"))
  try {
    writeFileSync(join(root, "target"), "")
    symlinkSync(join(root, "target"), join(root, "link"), "file")
    return true
  } catch {
    return false
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})()

/** POSIX permission bits and the executable bit are not enforced on Windows filesystems. */
export const supportsPosixModes = !isWindows

/** Windows filenames reject the glob metacharacters * and ? as well as the pathspec colon. */
export const supportsLiteralGlobNames = !isWindows

/** Windows tooling does not round-trip control characters such as newlines in file names. */
export const supportsNewlineFilenames = !isWindows
