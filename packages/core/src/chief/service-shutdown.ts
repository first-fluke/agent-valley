import { pendingCodeDelivery } from "./code-delivery-contract"
import { assertExecutionBudget, assertExecutionDeadline, MissionPause, recordPause } from "./execution"
import type { Mission } from "./types"
import { markOperatingRunUnknown } from "./usage"

export function serviceShutdownPause(): MissionPause {
  return new MissionPause(
    "The OS-owned service is shutting down. Re-observe the saved execution before continuing the same goal within its original limits.",
    "service-shutdown",
  )
}

export function isServiceShutdown(signal?: AbortSignal): boolean {
  return signal?.reason instanceof MissionPause && signal.reason.kind === "service-shutdown"
}

export function interruptionPause(signal: AbortSignal | undefined, fallback: string): MissionPause {
  return signal?.reason instanceof MissionPause ? signal.reason : new MissionPause(fallback, "interrupted")
}

/** A service handoff authorizes re-observation, never a reset or an uncertain-effect replay. */
export function recordServiceShutdown(mission: Mission, unconfirmedTermination?: Error): void {
  const pause = serviceShutdownPause()
  if (mission.history.at(-1)?.stage !== "service-shutdown")
    mission.history.push({ at: new Date().toISOString(), stage: "service-shutdown", message: pause.message })
  const protectedKinds = ["interrupted", "budget", "integrity", "unknown-effect", "chief-unavailable"]
  if (protectedKinds.includes(mission.execution?.failureKind ?? "")) return
  if (
    mission.status === "paused" &&
    mission.execution?.failureKind &&
    mission.execution.failureKind !== "service-shutdown"
  )
    return
  if (mission.status === "failed" && mission.execution?.failureKind !== "service-shutdown") return
  if (unconfirmedTermination) {
    recordPause(mission, new MissionPause(unconfirmedTermination.message, "unknown-effect"))
    return
  }
  if (mission.status === "completed") {
    if (pendingCodeDelivery(mission)) {
      try {
        assertExecutionDeadline(mission)
      } catch (error) {
        if (!(error instanceof MissionPause)) throw error
        if (mission.codeDelivery) {
          mission.codeDelivery.phase = "blocked"
          mission.codeDelivery.error = error.message
          delete mission.codeDelivery.nextRunAt
        }
      }
    }
  } else {
    for (const run of mission.operations?.runs ?? []) {
      if (!run.finishedAt && run.executionState !== "settled")
        markOperatingRunUnknown(
          run,
          "Service shutdown interrupted this execution. Matching process-guard proof is required before recovery.",
        )
    }
    let disposition = pause
    try {
      assertExecutionBudget(mission)
    } catch (error) {
      if (!(error instanceof MissionPause)) throw error
      disposition = error
    }
    recordPause(mission, disposition)
    if (disposition.kind === "service-shutdown" && mission.supervision)
      mission.supervision.pendingRecovery ??= { reason: pause.message }
  }
}
