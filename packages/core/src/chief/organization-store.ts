import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { chmod, link, lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { z } from "zod"

const MAX_RECORD_BYTES = 16_000_000
const MAX_RECORDS = 10_000
const MAX_HISTORY_BYTES = 64_000_000
const READ_BATCH_SIZE = 16
export type OrganizationCategory = "memories" | "metrics" | "experiments" | "outcomes"
export function organizationRecordKey(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
export function organizationStorePath(sourceRepo: string): string {
  return join(resolve(sourceRepo), ".agent-valley", "organization")
}
async function directory(sourceRepo: string, category: OrganizationCategory, create: boolean): Promise<string> {
  const root = await realpath(sourceRepo)
  let path = root
  for (const part of [".agent-valley", "organization", category]) {
    path = join(path, part)
    if (create)
      await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error
      })
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path)
      throw new Error(
        "Organization storage must use regular directories inside the source repository. Remove the unsafe symlink.",
      )
    if (create) await chmod(path, 0o700)
  }
  return path
}
async function readRecord<T>(
  path: string,
  repository: string,
  schema: z.ZodType<T>,
  charge?: (bytes: number) => void,
): Promise<T> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES)
      throw new Error("Organization record is not a bounded regular JSON file. Restore its original record.")
    charge?.(stat.size)
    const envelope = JSON.parse(await file.readFile("utf8")) as {
      version?: unknown
      repository?: unknown
      data?: unknown
    }
    if (envelope.version !== 1 || envelope.repository !== repository)
      throw new Error("Organization record version or repository identity does not match. Restore the original record.")
    return schema.parse(envelope.data)
  } finally {
    await file.close()
  }
}
export async function readOrganizationRecords<T>(
  sourceRepo: string,
  category: OrganizationCategory,
  schema: z.ZodType<T>,
): Promise<T[]> {
  let path: string
  try {
    path = await directory(sourceRepo, category, false)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  const names = (await readdir(path)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort()
  if (names.length > MAX_RECORDS)
    throw new Error("Organization history exceeds 10000 records. Archive older records before continuing.")
  const repository = await realpath(sourceRepo)
  let bytes = 0
  const charge = (size: number) => {
    bytes += size
    if (bytes > MAX_HISTORY_BYTES)
      throw new Error("Organization history exceeds 64 MB. Archive older records before continuing.")
  }
  const records: T[] = []
  for (let index = 0; index < names.length; index += READ_BATCH_SIZE)
    records.push(
      ...(await Promise.all(
        names
          .slice(index, index + READ_BATCH_SIZE)
          .map((name) => readRecord(join(path, name), repository, schema, charge)),
      )),
    )
  return records
}
/** Immutable records are atomically published with an exclusive hard link: concurrent writes never replace history. */
export async function appendOrganizationRecord<T>(
  sourceRepo: string,
  category: OrganizationCategory,
  identity: unknown,
  data: T,
  schema: z.ZodType<T>,
  idempotent = false,
): Promise<T> {
  const validated = schema.parse(data)
  const path = await directory(sourceRepo, category, true)
  const repository = await realpath(sourceRepo)
  const destination = join(path, `${organizationRecordKey(identity)}.json`)
  const temporary = join(path, `.${randomUUID()}.tmp`)
  const content = JSON.stringify({ version: 1, repository, data: validated })
  if (Buffer.byteLength(content) > MAX_RECORD_BYTES)
    throw new Error("Organization record exceeds 16 MB. Reduce stored run evidence.")
  const file = await open(temporary, "wx", 0o600)
  try {
    await file.writeFile(content)
    await file.sync()
  } finally {
    await file.close()
  }
  try {
    await link(temporary, destination)
    return validated
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const existing = await readRecord(destination, repository, schema)
    const comparable = (value: T) => {
      const { createdAt: _createdAt, ...rest } = value as Record<string, unknown>
      return JSON.stringify(rest)
    }
    if (!idempotent && comparable(existing) !== comparable(validated))
      throw new Error("An organization record with this ID already has different evidence. Use a new observation ID.")
    return existing
  } finally {
    await unlink(temporary).catch(() => {})
  }
}
