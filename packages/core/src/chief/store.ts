import { randomUUID } from "node:crypto"
import { mkdir, open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ActiveMissionProcess } from "./active-process"
import { missionSchema } from "./schemas"
import type { Mission } from "./types"

export class MissionStore {
  private writes: Promise<void> = Promise.resolve()
  constructor(private readonly directory: string) {}

  processGuard(id: string, runId?: string): ActiveMissionProcess {
    this.path(id)
    return new ActiveMissionProcess(this.directory, id, runId)
  }

  async recoverProcesses(id: string): Promise<void> {
    this.path(id)
    const names = await readdir(this.directory)
    for (const name of names) {
      if (name === `${id}.active`) await this.processGuard(id).recoverOrphan()
      else if (name.startsWith(`${id}.run-`) && name.endsWith(".active"))
        await this.processGuard(id, name.slice(id.length + 5, -7)).recoverOrphan()
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
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, mission }, null, 2), { mode: 0o600, flag: "wx" })
      await rename(temporary, path)
    } finally {
      await unlink(temporary).catch(() => {})
    }
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

  /** A second CLI cannot resume a live mission. Dead-owner locks fail closed to avoid a reclaim race. */
  async lock(id: string): Promise<() => Promise<void>> {
    const path = `${this.path(id)}.lock`
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const token = randomUUID()
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const file = await open(path, "wx", 0o600)
        try {
          await file.writeFile(JSON.stringify({ pid: process.pid, token }))
        } finally {
          await file.close()
        }
        return async () => {
          const current = JSON.parse(await readFile(path, "utf8")) as { token?: string }
          if (current.token === token) await unlink(path)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        await this.reclaimStaleLock(path, id)
      }
    }
    throw new Error(`Could not acquire mission ${id}. Another process resumed it; try av missions.`)
  }

  private async reclaimStaleLock(path: string, id: string): Promise<void> {
    const guardPath = `${path}.reclaim`
    const guard = await open(guardPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
      throw new Error(
        `Mission ${id} lock recovery is already in progress. Retry --resume ${id}; if it persists, inspect ${guardPath} and remove it only after its owner has stopped.`,
      )
    })
    try {
      await guard.writeFile(JSON.stringify({ pid: process.pid }))
      // Re-read under an exclusive recovery guard: another contender may have
      // replaced the stale lock since our initial acquisition failed.
      const content = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null
        throw error
      })
      if (content === null) return
      const lock = JSON.parse(content) as { pid?: number }
      if (!Number.isInteger(lock.pid) || (lock.pid ?? 0) < 2)
        throw new Error(`Invalid mission lock at ${path}. Inspect it before removing it.`)
      try {
        process.kill(lock.pid as number, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
        await unlink(path)
        return
      }
      throw new Error(`Mission ${id} is already running (PID ${lock.pid}). Stop that run before resuming.`)
    } finally {
      await guard.close()
      await unlink(guardPath)
    }
  }
}
