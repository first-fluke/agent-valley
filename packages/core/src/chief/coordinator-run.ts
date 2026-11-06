import { classifyAgentExhaustion } from "../domain/agent-exhaustion"
import { createMissionCheckpoint } from "./coordinator-checkpoint"
import { assertNoUncertainExecution, classifyFailure, MissionPause, reserveExecutionRun } from "./execution"
import {
  FreeModelRouteUnavailable,
  handoffActor,
  handoffPrompt,
  prepareHandoff,
  recordHandoffReview,
  refreshFreeModelRoute,
} from "./handoff"
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
  const validatedFreeRoutes = new Set<string>()
  const runOnce = async (
    actor: Persona,
    prompt: string,
    stage: ChiefStage,
    taskId?: string,
    context?: { workspace?: Mission["workspace"]; signal?: AbortSignal; handoff?: string },
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
    if (context?.handoff) recordHandoffReview(mission, actor, stage, taskId)
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
      if (classifyAgentExhaustion(error instanceof Error ? error.message : String(error))) throw error
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

  return async (
    actor: Persona,
    prompt: string,
    stage: ChiefStage,
    taskId?: string,
    context?: { workspace?: Mission["workspace"]; signal?: AbortSignal },
  ): Promise<string> => {
    checkAbort()
    ports.signal?.throwIfAborted()
    let selected = handoffActor(mission, actor)
    let reason = selected === actor ? undefined : "Continue the saved authenticated handoff route."
    let currentPrompt = reason ? handoffPrompt(mission, prompt, stage, taskId) : prompt
    const workspace = context?.workspace?.path ?? mission.workspace.path
    const rememberFreeRoute = () => {
      if (selected.model && mission.handoff?.freeRoutes?.[selected.id] === selected.model)
        validatedFreeRoutes.add(`${workspace}\0${selected.model}`)
    }
    const redirect = async (error: unknown): Promise<boolean> => {
      checkAbort()
      let next: Awaited<ReturnType<typeof prepareHandoff>>
      try {
        next = await prepareHandoff(mission, ports, selected, stage, taskId, error)
      } catch (failure) {
        ports.signal?.throwIfAborted()
        checkAbort()
        // Exhausted providers and spent continuation allowances survive a stopped supervisor.
        await persist("Handoff checkpoint could not be saved. Restore writable mission storage before resuming.")
        throw failure
      }
      if (!next) return false
      selected = next.actor
      rememberFreeRoute()
      reason = next.reason
      currentPrompt = handoffPrompt(mission, prompt, stage, taskId)
      mission.history.push({
        at: new Date().toISOString(),
        stage: "handoff",
        message: reason,
        ...(taskId ? { taskId } : {}),
      })
      await persist("Handoff checkpoint could not be saved. Restore writable mission storage before resuming.")
      return true
    }
    try {
      const refreshed = await refreshFreeModelRoute(mission, ports, actor, selected, workspace, validatedFreeRoutes)
      if (refreshed) {
        selected = refreshed.actor
        reason = refreshed.reason
        currentPrompt = handoffPrompt(mission, prompt, stage, taskId)
        mission.history.push({
          at: new Date().toISOString(),
          stage: "handoff",
          message: reason,
          ...(taskId ? { taskId } : {}),
        })
        await persist(
          "Free model route checkpoint could not be saved. Restore writable mission storage before resuming.",
        )
      }
    } catch (error) {
      if (!(error instanceof FreeModelRouteUnavailable) || !(await redirect(error))) throw error
    }
    for (;;) {
      if (
        actor.id !== mission.chiefId &&
        mission.handoff?.unavailableAgents?.some((vendor) => vendor === selected.agentType)
      )
        await redirect(new Error("Model is unavailable"))
      if (mission.handoff?.exhaustedAgents.some((vendor) => vendor === selected.agentType))
        await redirect(new Error("usage_limit_reached"))
      try {
        return await runOnce(selected, currentPrompt, stage, taskId, reason ? { ...context, handoff: reason } : context)
      } catch (error) {
        if (error instanceof ReadOnlyViolation || !(await redirect(error))) throw error
      }
    }
  }
}
