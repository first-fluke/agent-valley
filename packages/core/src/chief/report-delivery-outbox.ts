import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { mkdir, open, readdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { z } from "zod"
import type { ReportAttachment } from "../domain/ports/report-channel"
import {
  MAX_REPORT_ATTACHMENTS,
  ReportDeliveryError,
  type ReportDeliveryReceipt,
  reportAttachmentSchema,
} from "./report-delivery-contract"
import { MissionStore } from "./store"

const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const outboxRecordSchema = z
  .strictObject({
    version: z.literal(1),
    id: hash,
    missionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
    missionStatus: z.enum(["completed", "failed"]),
    destinationId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
    channel: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    reportHash: hash,
    destinationHash: hash.optional(),
    goal: z.string().max(32_000),
    markdown: z.string().max(256_000),
    reportPath: z.string().max(4_096),
    attachments: z.array(reportAttachmentSchema).max(MAX_REPORT_ATTACHMENTS),
    status: z.enum(["delivered", "pending", "failed"]),
    attempts: z.number().int().min(0),
    nextPart: z.number().int().min(0),
    parts: z.number().int().min(1).max(2_000),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    message: z.string().max(1_000),
  })
  .refine(
    (record) => record.nextPart <= record.parts && (record.status !== "delivered" || record.nextPart === record.parts),
  )
export type OutboxRecord = z.infer<typeof outboxRecordSchema>

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex")
}

export function receipt(record: OutboxRecord): ReportDeliveryReceipt {
  const {
    version: _version,
    goal: _goal,
    markdown: _markdown,
    reportPath: _path,
    attachments: _attachments,
    destinationHash: _destination,
    ...result
  } = record
  return result
}

export class ReportOutbox {
  readonly directory: string
  constructor(stateDir: string) {
    this.directory = join(stateDir, "report-outbox")
  }

  private path(id: string): string {
    if (!hash.safeParse(id).success) throw new Error("Invalid report receipt ID. Use av reports to find a receipt.")
    return join(this.directory, `${id}.json`)
  }

  lock(id: string): Promise<() => Promise<void>> {
    return new MissionStore(this.directory).lock(id)
  }

  async load(id: string): Promise<OutboxRecord | null> {
    let content: string
    try {
      content = await readFile(this.path(id), "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw new Error("Cannot read report outbox. Restore access to the Chief Director state directory.")
    }
    try {
      const record = outboxRecordSchema.parse(JSON.parse(content))
      if (record.id !== id) throw new Error("Identity mismatch")
      return record
    } catch {
      throw new Error("Invalid saved report receipt. Restore its original outbox record before retrying.")
    }
  }

  async save(record: OutboxRecord): Promise<void> {
    outboxRecordSchema.parse(record)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const path = this.path(record.id)
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(record, null, 2), { mode: 0o600, flag: "wx" })
      await rename(temporary, path)
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }

  async list(): Promise<OutboxRecord[]> {
    const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw new Error("Cannot list report outbox. Restore access to the Chief Director state directory.")
    })
    const records = await Promise.all(
      names
        .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .sort()
        .map((name) => this.load(name.slice(0, -5))),
    )
    return records.filter((record): record is OutboxRecord => record !== null)
  }
}

/** Resolve containment and read the same opened regular file whose bytes are hashed. */
export async function readReportAttachment(
  attachment: ReportAttachment,
  artifactRoot: string,
): Promise<Uint8Array<ArrayBuffer>> {
  return (await verifiedAttachment(attachment, artifactRoot, true)) as Uint8Array<ArrayBuffer>
}

export async function validateReportAttachment(attachment: ReportAttachment, artifactRoot: string): Promise<void> {
  await verifiedAttachment(attachment, artifactRoot, false)
}

async function verifiedAttachment(
  attachment: ReportAttachment,
  artifactRoot: string,
  readBytes: boolean,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const failure = new ReportDeliveryError(
    "Capture file is missing, changed, or outside the artifact directory. Restore the original capture and retry av reports.",
    true,
    false,
  )
  try {
    const root = await realpath(artifactRoot)
    const path = await realpath(attachment.path)
    const local = relative(root, path)
    if (
      !local ||
      local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      local === ".." ||
      isAbsolute(local)
    )
      throw failure
    if (resolve(attachment.path) !== attachment.path) throw failure
    const file = await open(attachment.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size !== attachment.sizeBytes) throw failure
      if (!readBytes) {
        const digest = createHash("sha256")
        for await (const chunk of file.createReadStream({ autoClose: false })) digest.update(chunk)
        if (digest.digest("hex") !== attachment.sha256) throw failure
        return
      }
      const bytes = await file.readFile()
      if (bytes.byteLength !== attachment.sizeBytes || sha256(bytes) !== attachment.sha256) throw failure
      if (!(bytes.buffer instanceof ArrayBuffer)) throw failure
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    } finally {
      await file.close()
    }
  } catch {
    throw failure
  }
}

/** Fixed byte limits also keep UTF-8 Korean and emoji safely inside provider text limits. */
export function reportChunks(markdown: string): string[] {
  const chunks: string[] = []
  let chunk = ""
  let size = 0
  for (const character of markdown || "(empty report)") {
    const bytes = Buffer.byteLength(character)
    if (size + bytes > 1_800) {
      chunks.push(chunk)
      chunk = ""
      size = 0
    }
    chunk += character
    size += bytes
  }
  chunks.push(chunk)
  return chunks
}
