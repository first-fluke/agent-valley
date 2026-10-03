import { reserveExecutionRun } from "./execution"
import type { ChiefPorts, ChiefStage, Mission, Persona } from "./types"

export class ReadOnlyViolation extends Error {}
export class CheckpointError extends Error {}

export function createMissionRun(
  mission: Mission,
  ports: ChiefPorts,
  assertContract: () => void,
  checkAbort: () => void,
) {
  return async (
    actor: Persona,
    prompt: string,
    stage: ChiefStage,
    taskId?: string,
    context?: { workspace?: Mission["workspace"]; signal?: AbortSignal },
  ): Promise<string> => {
    checkAbort()
    reserveExecutionRun(mission)
    if (mission.executionPolicy) {
      try {
        await ports.save(mission)
      } catch {
        throw new CheckpointError(
          "Actor budget reservation could not be saved. Restore writable mission storage before resuming.",
        )
      }
    }
    const before = await ports.fingerprint(mission)
    let output: string
    try {
      output =
        taskId || context
          ? await ports.runAgent(actor, prompt, mission, stage, { ...context, ...(taskId ? { taskId } : {}) })
          : await ports.runAgent(actor, prompt, mission, stage)
    } catch (error) {
      mission.fingerprint = await ports.fingerprint(mission)
      assertContract()
      if (stage !== "work" && before !== mission.fingerprint)
        throw new ReadOnlyViolation(
          `${stage} Actor changed the worktree during a read-only stage. Inspect those changes before resuming.`,
        )
      checkAbort()
      throw error
    }
    mission.fingerprint = await ports.fingerprint(mission)
    assertContract()
    if (stage !== "work" && before !== mission.fingerprint)
      throw new ReadOnlyViolation(
        `${stage} Actor changed the worktree during a read-only stage. Inspect those changes before resuming.`,
      )
    checkAbort()
    return output
  }
}
