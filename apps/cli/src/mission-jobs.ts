import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { isProcessAlive, processIdentity } from "@agent-valley/core/chief/process-identity"
import { MissionStore } from "@agent-valley/core/chief/store"
import { z } from "zod"

const jobSchema = z.object({
  version: z.literal(1),
  requestId: z.string(),
  inputHash: z.string(),
  missionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/),
  kind: z.enum(["order", "resume"]),
  phase: z.enum(["prepared", "started", "failed"]),
  createdAt: z.string(),
  pid: z.number().int().positive().optional(),
  identity: z.string().optional(),
  error: z.string().optional(),
  goal: z.string().max(32_000).optional(),
  cancelRequestedAt: z.string().optional(),
})

export type MissionJob = z.infer<typeof jobSchema>
export type JobLiveness = "running" | "stopped" | "unknown"

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

/** A reused PID or unavailable process identity must never authorize a signal. */
export function jobLiveness(job: MissionJob): JobLiveness {
  if (job.phase !== "started" || !job.pid) return job.phase === "prepared" ? "unknown" : "stopped"
  if (!isProcessAlive(job.pid)) return "stopped"
  const actual = processIdentity(job.pid)
  if (!actual || !job.identity) return "unknown"
  return actual === job.identity ? "running" : "stopped"
}

export async function ensureAvDirectory(root: string, parts: string[]): Promise<string> {
  let path = root
  for (const part of [".agent-valley", ...parts]) {
    path = join(path, part)
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
    })
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`AV control directory must be a real directory: ${path}. Remove the symlink before retrying.`)
  }
  return path
}

/** Receipts precede process creation. An uncertain launch is never replayed automatically. */
export class MissionJobs {
  private readonly directory: string

  constructor(
    private readonly root: string,
    private readonly directoryName: "jobs" | "operation-jobs" = "jobs",
  ) {
    this.directory = join(root, ".agent-valley/control", directoryName)
  }

  async locked<T>(operation: () => Promise<T>): Promise<T> {
    await ensureAvDirectory(this.root, ["control", this.directoryName])
    const release = await new MissionStore(this.directory).lock("submission")
    try {
      return await operation()
    } finally {
      await release()
    }
  }

  async findRequest(requestId: string): Promise<MissionJob | undefined> {
    await ensureAvDirectory(this.root, ["control", this.directoryName])
    try {
      const path = this.path(requestId)
      if ((await lstat(path)).isSymbolicLink()) throw new Error("AV launch receipt cannot be a symlink.")
      return jobSchema.parse(JSON.parse(await readFile(path, "utf8")))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw new Error(
        `Invalid AV launch receipt. Inspect .agent-valley/control/${this.directoryName} before retrying.`,
        {
          cause: error,
        },
      )
    }
  }

  async list(): Promise<MissionJob[]> {
    await ensureAvDirectory(this.root, ["control", this.directoryName])
    const files = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })
    return Promise.all(
      files
        .filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
        .map(async (file) => {
          const path = join(this.directory, file)
          if ((await lstat(path)).isSymbolicLink()) throw new Error(`AV launch receipt cannot be a symlink: ${path}`)
          return jobSchema.parse(JSON.parse(await readFile(path, "utf8")))
        }),
    )
  }

  async latest(missionId: string): Promise<MissionJob | undefined> {
    const matches = (await this.list()).filter((job) => job.missionId === missionId)
    return matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  }

  async save(job: MissionJob): Promise<void> {
    jobSchema.parse(job)
    const path = this.path(job.requestId)
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, JSON.stringify(job), { mode: 0o600, flag: "wx" })
      await rename(temp, path)
    } finally {
      await unlink(temp).catch(() => {})
    }
  }

  logPath(job: MissionJob): string {
    return join(this.directory, `${digest(job.requestId)}.log`)
  }

  private path(requestId: string): string {
    return join(this.directory, `${digest(requestId)}.json`)
  }
}
