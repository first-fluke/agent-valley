import type { ChiefPorts, Mission } from "./types"

export class CheckpointError extends Error {}

/** History and dispatch checkpoints share one boundary; MissionStore serializes runtime writes too. */
export function createMissionCheckpoint(mission: Mission, ports: Pick<ChiefPorts, "save">, assertContract: () => void) {
  const persist = async (failureMessage?: string): Promise<void> => {
    try {
      await ports.save(mission)
    } catch (error) {
      if (failureMessage) throw new CheckpointError(failureMessage)
      throw error
    }
  }
  const record = async (stage: string, message: string, taskId?: string): Promise<void> => {
    assertContract()
    mission.updatedAt = new Date().toISOString()
    mission.history.push({ at: mission.updatedAt, stage, message, ...(taskId ? { taskId } : {}) })
    await persist("Mission checkpoint could not be saved. Restore writable mission storage before resuming.")
  }
  const transition = async (
    status: Mission["status"],
    stage: string,
    message: string,
    taskId?: string,
  ): Promise<void> => {
    mission.status = status
    await record(stage, message, taskId)
  }
  return { persist, record, transition }
}
