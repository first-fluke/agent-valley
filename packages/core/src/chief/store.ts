import { constants } from "node:fs"
import { mkdir, open, readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { writeJsonAtomic } from "../util/atomic-json"
import { lockRecord } from "../util/record-lock"
import { ActiveMissionProcess } from "./active-process"
import { reconcileExecution } from "./execution"
import { missionSchema } from "./schemas"
import type { Mission } from "./types"

export class MissionStore {
  private writes: Promise<void> = Promise.resolve()
  constructor(private readonly directory: string) {}

  processGuard(id: string, runId?: string): ActiveMissionProcess {
    this.path(id)
    return new ActiveMissionProcess(this.directory, id, runId)
  }

  /** Observation only; acquisition and dead-owner reclamation remain atomic in lock(). */
  async isLocked(id: string): Promise<boolean> {
    const path = `${this.path(id)}.lock`
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      const stat = await file.stat()
      if (!stat.isFile() || stat.size < 1 || stat.size > 1024) return true
      const bytes = Buffer.alloc(1025)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      if (bytesRead > 1024) return true
      const lock = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")) as { pid?: unknown; token?: unknown }
      if (typeof lock.token !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(lock.token))
        return true
      if (typeof lock.pid !== "number" || !Number.isInteger(lock.pid) || lock.pid < 2 || lock.pid > 2147483647)
        return true
      try {
        process.kill(lock.pid, 0)
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH"
      }
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT"
    } finally {
      await file?.close().catch(() => {})
    }
  }

  async recoverProcesses(id: string, mission?: Mission): Promise<void> {
    this.path(id)
    if (mission && mission.id !== id)
      throw new Error("Process recovery mission identity differs from its record. Restore the matching checkpoint.")
    const names = await readdir(this.directory)
    for (const name of names) {
      if (name === `${id}.active`) await this.processGuard(id).recoverOrphan()
      else if (name.startsWith(`${id}.run-`) && name.endsWith(".active")) {
        const runId = name.slice(id.length + 5, -7)
        await this.processGuard(id, runId).recoverOrphan()
        const run = mission?.operations?.runs.find((entry) => entry.runId === runId)
        if (mission && run?.executionState === "unknown" && run.executionRecovery === "local-process") {
          reconcileExecution(
            mission,
            runId,
            "The local process guard confirmed that the recorded execution and its process group stopped.",
            "local-process-guard",
          )
          await this.save(mission)
        }
      }
    }
  }

  private path(id: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/.test(id))
      throw new Error("Invalid mission ID. Use the ID printed by av order.")
    return join(this.directory, `${id}.json`)
  }

  save(mission: Mission): Promise<void> {
    const write = this.writes.then(() => this.persist(mission))
    this.writes = write.catch(() => {})
    return write
  }

  private async persist(mission: Mission): Promise<void> {
    const path = this.path(mission.id)
    missionSchema.parse(mission)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await writeJsonAtomic(path, { version: 1, mission })
  }

  async load(id: string): Promise<Mission> {
    const content = JSON.parse(await readFile(this.path(id), "utf8")) as { version?: unknown; mission?: unknown }
    if (content.version !== 1)
      throw new Error("Unsupported mission record version. Use the Agent Valley version that created this mission.")
    const mission = missionSchema.parse(content.mission)
    if (mission.id !== id)
      throw new Error("Mission file identity does not match its filename. Restore the original record.")
    return mission
  }

  async list(): Promise<Mission[]> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    return Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => this.load(name.slice(0, -5))),
    )
  }

  /** Acquisition rechecks ownership atomically and reclaims only proven-dead owners. */
  async lock(id: string): Promise<() => Promise<void>> {
    return lockRecord(`${this.path(id)}.lock`, `Mission ${id}`, "mission")
  }
}
