import { createHash, randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"

export interface IntegrationFile {
  path: string
  before: string | null
  after: string
  mode: number
  writeMode?: number
}

export function integrationConflict(path: string, reason: string): Error {
  return new Error(
    `${path}: ${reason}. Keep or move the conflicting file aside, then rerun av integrations install --workspace <repository>.`,
  )
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

export async function safeIntegrationPath(root: string, path: string): Promise<void> {
  const local = relative(root, path)
  if (local === ".." || local.startsWith(`..${sep}`)) throw integrationConflict(path, "path is outside the repository")
  let current = root
  for (const part of local.split(sep).filter(Boolean)) {
    current = join(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw integrationConflict(current, "symbolic links are not modified")
      if (current !== path && !info.isDirectory()) throw integrationConflict(current, "expected a directory")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
}

export async function integrationFile(
  root: string,
  path: string,
  after: string,
  defaultMode = 0o600,
): Promise<IntegrationFile> {
  await safeIntegrationPath(root, path)
  try {
    const info = await lstat(path)
    if (!info.isFile()) throw integrationConflict(path, "expected a regular file")
    return { path, before: await readFile(path, "utf8"), after, mode: info.mode & 0o777 }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return { path, before: null, after, mode: defaultMode }
  }
}

async function replaceFile(file: IntegrationFile, content: string, mode = file.mode): Promise<void> {
  await mkdir(dirname(file.path), { recursive: true })
  const temporary = `${file.path}.av-${randomUUID()}`
  try {
    await writeFile(temporary, content, { flag: "wx", mode })
    await chmod(temporary, mode)
    await rename(temporary, file.path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function applyIntegrationFiles(root: string, files: IntegrationFile[]): Promise<string[]> {
  const changed = files.filter(
    (file) => file.before !== file.after || (file.writeMode !== undefined && file.writeMode !== file.mode),
  )
  const applied: IntegrationFile[] = []
  try {
    for (const file of changed) {
      const current = await integrationFile(root, file.path, file.after, file.mode)
      if (current.before !== file.before || current.mode !== file.mode) {
        throw integrationConflict(file.path, "file changed during installation; no concurrent edits are overwritten")
      }
      await replaceFile(file, file.after, file.writeMode ?? file.mode)
      applied.push(file)
    }
  } catch (error) {
    const failures: string[] = []
    for (const file of applied.reverse()) {
      try {
        const current = await integrationFile(root, file.path, file.after, file.mode)
        if (current.before !== file.after || current.mode !== (file.writeMode ?? file.mode))
          throw new Error("changed since installation")
        if (file.before === null) await rm(file.path)
        else await replaceFile(file, file.before)
      } catch {
        failures.push(file.path)
      }
    }
    if (failures.length)
      throw new Error(
        `${String(error)} Restore retained installation files after inspecting concurrent changes: ${failures.join(", ")}.`,
      )
    throw error
  }
  return changed.map((file) => file.path)
}
