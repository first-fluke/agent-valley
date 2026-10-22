import { mkdir, readdir, readFile } from "node:fs/promises"
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

  /** A second CLI cannot resume a live mission. Dead-owner locks fail closed to avoid a reclaim race. */
  async lock(id: string): Promise<() => Promise<void>> {
    return lockRecord(`${this.path(id)}.lock`, `Mission ${id}`, "mission")
  }
}
