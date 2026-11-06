import type { RunAttempt } from "../domain/models"
import { assertActorAvailable } from "./actor-availability"
import type { OperatingRun } from "./operations"
import type { ChiefRunContext, ChiefStage, Mission, Persona } from "./types"
import { startOperatingRun } from "./usage"

/** Health check and the persisted half-open claim precede the first asynchronous admission step. */
export async function admitNativeDispatch(
  mission: Mission,
  actor: Persona,
  attempt: RunAttempt,
  stage: ChiefStage,
  context: ChiefRunContext | undefined,
  local: boolean,
  reason?: string,
): Promise<OperatingRun> {
  assertActorAvailable(mission, actor, stage)
  let entry: OperatingRun | undefined
  const claim = () => {
    if (entry) throw new Error("Native dispatch admission claimed the same Actor call twice.")
    assertActorAvailable(mission, actor, stage)
    entry = startOperatingRun(mission, actor, attempt, stage, context?.taskId, reason)
    entry.executionRecovery = local ? "local-process" : "reconcile"
  }
  try {
    if (context?.beforeDispatch) await context.beforeDispatch(claim)
    else claim()
    if (!entry) throw new Error("Native dispatch admission did not claim its Actor call.")
    return entry
  } catch (error) {
    // No runner has been invoked. A rejected admission is not a native Actor failure.
    if (entry) mission.operations?.runs.splice(mission.operations.runs.indexOf(entry), 1)
    throw error
  }
}
