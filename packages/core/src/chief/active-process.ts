import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { isProcessAlive, processIdentity } from "./process-identity"

const markerSchema = z.strictObject({
  version: z.literal(1),
  token: z.string().uuid(),
  stage: z.string().min(1).max(100),
  pid: z.number().int().min(2).nullable(),
  group: z.boolean(),
  ownerPid: z.number().int().min(2).optional(),
  identity: z.string().optional(),
})

type ProcessMarker = z.infer<typeof markerSchema>

/** The mission lock serializes callers; this marker survives a coordinator crash. */
export class ActiveMissionProcess {
  private readonly path: string
  private token?: string

  constructor(
    private readonly directory: string,
    private readonly missionId: string,
    runId?: string,
  ) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/.test(missionId)) throw new Error("Invalid mission ID.")
    if (runId && !/^[a-zA-Z0-9-]{1,80}$/.test(runId)) throw new Error("Invalid process run ID.")
    this.path = join(directory, `${missionId}${runId ? `.run-${runId}` : ""}.active`)
  }

  assertIdle(): void {
    const marker = this.read()
    if (!marker) return
    if (marker.pid === null) {
      throw new Error(
        `Mission ${this.missionId} stopped during ${marker.stage} before recording its Actor PID. Inspect running Actors and verification commands, stop any Actor for this mission, then remove ${this.path} and resume.`,
      )
    }
    if (!this.isRunning(marker.pid, marker.group)) {
      unlinkSync(this.path)
      return
    }
    throw new Error(
      `Mission ${this.missionId} still has a running ${marker.stage} Actor (${marker.group ? "process group" : "PID"} ${marker.pid}). Stop that Actor or wait for it to exit before resuming.`,
    )
  }

  begin(stage: string): void {
    this.assertIdle()
    const marker = markerSchema.parse({
      version: 1,
      token: randomUUID(),
      stage,
      pid: null,
      group: false,
      ownerPid: process.pid,
    })
    this.write(marker)
    this.token = marker.token
  }

  spawned(pid: number | undefined, group = false): void {
    const marker = this.read()
    if (!marker || !this.token || marker.token !== this.token)
      throw new Error(`Mission ${this.missionId} lost its process marker. Inspect ${this.path} before resuming.`)
    this.write(
      markerSchema.parse({ ...marker, pid: pid ?? null, group, identity: pid ? processIdentity(pid) : undefined }),
    )
  }

  /** Reclaim only a dead coordinator's proven child; a reused or unknown PID stays blocked. */
  async recoverOrphan(): Promise<void> {
    const marker = this.read()
    if (!marker) return
    if (marker.pid !== null && !this.isRunning(marker.pid, marker.group)) {
      unlinkSync(this.path)
      return
    }
    if (!marker.ownerPid || isProcessAlive(marker.ownerPid)) {
      this.assertIdle()
      return
    }
    if (marker.pid === null || !marker.identity || processIdentity(marker.pid) !== marker.identity)
      throw new Error(
        `Mission ${this.missionId} has an uncertain orphan process. Inspect ${this.path}; do not resume external actions until reconciled.`,
      )
    process.kill(marker.group ? -marker.pid : marker.pid, "SIGTERM")
    for (let attempt = 0; attempt < 40; attempt++) {
      if (!this.isRunning(marker.pid, marker.group)) {
        unlinkSync(this.path)
        return
      }
      if (attempt === 20) {
        if (processIdentity(marker.pid) !== marker.identity) break
        process.kill(marker.group ? -marker.pid : marker.pid, "SIGKILL")
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
    }
    throw new Error(`Mission ${this.missionId} orphan cleanup is incomplete. Inspect ${this.path} before resuming.`)
  }

  finish(): void {
    if (!this.token) return
    const marker = this.read()
    if (marker?.token === this.token) {
      if (marker.pid !== null && this.isRunning(marker.pid, marker.group)) {
        throw new Error(
          `Mission ${this.missionId} Actor cleanup is incomplete (PID ${marker.pid}). Retained ${this.path}; stop the remaining Actor before resuming.`,
        )
      }
      unlinkSync(this.path)
    }
    this.token = undefined
  }

  private isRunning(pid: number, group: boolean): boolean {
    try {
      process.kill(group ? -pid : pid, 0)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
      throw new Error(
        `Cannot inspect mission ${this.missionId} Actor PID ${pid}. Keep ${this.path} until the Actor has stopped, then retry resume.`,
        { cause: error },
      )
    }
  }

  private read(): ProcessMarker | null {
    let content: string
    try {
      content = readFileSync(this.path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
    try {
      return markerSchema.parse(JSON.parse(content))
    } catch (error) {
      throw new Error(
        `Invalid mission process marker at ${this.path}. Inspect running Actors before repairing or removing it.`,
        { cause: error },
      )
    }
  }

  private write(marker: ProcessMarker): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(marker), { mode: 0o600, flag: "wx" })
      renameSync(temporary, this.path)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}
