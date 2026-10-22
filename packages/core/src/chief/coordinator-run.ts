import { createMissionCheckpoint } from "./coordinator-checkpoint"
import { assertNoUncertainExecution, classifyFailure, MissionPause, reserveExecutionRun } from "./execution"
import type { ChiefPorts, ChiefStage, Mission, Persona } from "./types"

export class ReadOnlyViolation extends Error {}
export { CheckpointError } from "./coordinator-checkpoint"

export function createMissionRun(
  mission: Mission,
  ports: ChiefPorts,
  assertContract: () => void,
  checkAbort: () => void,
  persist = createMissionCheckpoint(mission, ports, assertContract).persist,
) {
  return async (
    actor: Persona,
    prompt: string,
    stage: ChiefStage,
    taskId?: string,
    context?: { workspace?: Mission["workspace"]; signal?: AbortSignal },
  ): Promise<string> => {
    assertNoUncertainExecution(mission)
    checkAbort()
    const task = stage === "work" ? mission.plan?.tasks.find((task) => task.id === taskId) : undefined
    const effect = task?.effectScope === "external" ? mission.tasks.find((state) => state.id === taskId) : undefined
    if (effect?.effectState === "unknown" || effect?.effectState === "running")
      throw new MissionPause(
        `External effect ${taskId} has no established outcome and will not be repeated.`,
        "unknown-effect",
      )
    if (effect?.effectState === "completed")
      throw new Error(`External effect ${taskId} already completed; review its evidence without repeating the Actor.`)
    const omaActor = stage === "work" ? await ports.prepareWork?.(actor, mission, context) : undefined
    checkAbort()
    assertContract()
    reserveExecutionRun(mission)
    if (mission.executionPolicy) {
      await persist("Actor budget reservation could not be saved. Restore writable mission storage before resuming.")
    }
    const before = await ports.fingerprint(mission)
    checkAbort()
    assertContract()
    if (effect) {
      const previous = effect.effectState ?? "not-started"
      effect.effectState = "running"
      try {
        await persist(
          "External dispatch checkpoint could not be saved. The Actor was not invoked and the effect remains not started.",
        )
      } catch (error) {
        effect.effectState = previous
        throw error
      }
      try {
        checkAbort()
      } catch (error) {
        effect.effectState = previous
        await persist(
          "The Actor was not invoked, but its cancelled dispatch checkpoint could not be saved. The effect remains not started in the retained coordinator state.",
        )
        throw error
      }
    }
    let output: string
    try {
      output =
        taskId || context || omaActor
          ? await ports.runAgent(actor, prompt, mission, stage, {
              ...context,
              ...(taskId ? { taskId } : {}),
              ...(omaActor ? { omaActor } : {}),
            })
          : await ports.runAgent(actor, prompt, mission, stage)
    } catch (error) {
      if (effect) effect.effectState = "unknown"
      assertNoUncertainExecution(mission)
      mission.fingerprint = await ports.fingerprint(mission)
      assertContract()
      if (stage !== "work" && before !== mission.fingerprint)
        throw new ReadOnlyViolation(
          `${stage} Actor changed the worktree during a read-only stage. Inspect those changes before resuming.`,
        )
      checkAbort()
      if (error instanceof MissionPause) throw error
      if (actor.id === mission.chiefId && stage !== "work" && stage !== "report") {
        const kind = classifyFailure(error instanceof Error ? error.message : String(error))
        if (kind === "provider" || kind === "rate-limit") throw error
        throw new MissionPause(
          `The selected Chief Director could not complete ${stage}: ${error instanceof Error ? error.message : String(error)}. Its goal, model and spent limits were retained; the outcome remains unresolved.`,
          "chief-unavailable",
        )
      }
      throw error
    }
    assertNoUncertainExecution(mission)
    if (effect) {
      effect.effectState = "completed"
      effect.output = output.slice(-32_000)
      await persist(
        "The Actor returned from its external action, but its completion checkpoint could not be saved. The retained effect will not be replayed during this run.",
      )
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
