import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import { A2A_ARTIFACT_MAX_FILE_BYTES, type A2aArtifactManifest, assertA2aPath } from "./a2a-artifact-contract"

export interface ArtifactImage {
  path: string
  sha256: string | null
  mode: number | null
}
export const artifactDigest = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

export async function artifactRoot(path: string): Promise<string> {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error("A2A artifact workspace must be a real repository directory. Restore it before applying artifacts.")
  return realpath(path)
}

/** Check every existing directory component rather than following a symlink. */
async function parentPath(root: string, path: string, create = false): Promise<string> {
  let current = root
  for (const part of path.split("/").slice(0, -1)) {
    current = join(current, part)
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      if (!create) return resolve(root, path)
      await mkdir(current, { mode: 0o755 }).catch((failure: NodeJS.ErrnoException) => {
        if (failure.code !== "EEXIST") throw failure
      })
      info = await lstat(current)
    }
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error(
        "A2A artifact parent is a symlink or not a directory. Restore the original product paths before resuming.",
      )
  }
  return resolve(root, path)
}

export async function artifactImage(root: string, path: string): Promise<ArtifactImage> {
  assertA2aPath(path)
  const target = await parentPath(root, path)
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, sha256: null, mode: null }
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o7000) !== 0)
    throw new Error("A2A artifact target must be a regular file without symlinks, submodules or privileged modes.")
  if (info.size > A2A_ARTIFACT_MAX_FILE_BYTES)
    throw new Error("Existing A2A artifact target exceeds 1 MiB. Select a smaller product file before dispatch.")
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.size > A2A_ARTIFACT_MAX_FILE_BYTES ||
      opened.ino !== info.ino ||
      opened.dev !== info.dev
    )
      throw new Error("A2A artifact target changed during inspection. Stop concurrent writers before resuming.")
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || bytes.length > A2A_ARTIFACT_MAX_FILE_BYTES)
      throw new Error("A2A artifact target changed while hashing. Stop concurrent writers before resuming.")
    return { path, sha256: artifactDigest(bytes), mode: opened.mode & 0o777 }
  } finally {
    await handle.close()
  }
}

export function desiredArtifact(file: A2aArtifactManifest["files"][number]): ArtifactImage {
  return { path: file.path, sha256: file.sha256, mode: file.sha256 === null ? null : file.executable ? 0o755 : 0o644 }
}

export const sameArtifact = (left: ArtifactImage, right: ArtifactImage): boolean =>
  left.path === right.path && left.sha256 === right.sha256 && left.mode === right.mode

export async function writeArtifact(
  root: string,
  file: A2aArtifactManifest["files"][number],
  expected: ArtifactImage,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const initial = await artifactImage(root, file.path)
  signal?.throwIfAborted()
  if (!sameArtifact(initial, expected))
    throw new Error("A2A artifact target changed before replacement. Stop concurrent writers and retain the journal.")
  if (file.contentBase64 === null) {
    const target = await parentPath(root, file.path)
    signal?.throwIfAborted()
    await unlink(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
    signal?.throwIfAborted()
    return
  }
  const target = await parentPath(root, file.path, true)
  signal?.throwIfAborted()
  // Staging remains in AV metadata, excluded from the product fingerprint even after a crash.
  const stagedName = `.agent-valley/a2a-artifact-staging/${randomUUID()}.tmp`
  const staged = await parentPath(root, stagedName, true)
  signal?.throwIfAborted()
  try {
    const handle = await open(staged, "wx", 0o600)
    try {
      signal?.throwIfAborted()
      await handle.writeFile(Buffer.from(file.contentBase64, "base64"))
      signal?.throwIfAborted()
    } finally {
      await handle.close()
    }
    signal?.throwIfAborted()
    await chmod(staged, file.executable ? 0o755 : 0o644)
    signal?.throwIfAborted()
    const current = await artifactImage(root, file.path)
    signal?.throwIfAborted()
    if (!sameArtifact(current, expected))
      throw new Error("A2A artifact target changed while staging. Stop concurrent writers and retain the journal.")
    await parentPath(root, file.path)
    signal?.throwIfAborted()
    await rename(staged, target)
    signal?.throwIfAborted()
  } finally {
    await unlink(staged).catch(() => {})
  }
}
