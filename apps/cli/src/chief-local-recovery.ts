import type { MissionStore } from "@agent-valley/core/chief/store"
import type { Mission } from "@agent-valley/core/chief/types"

/** Re-observe AV-owned processes; this never resolves a destination-side effect. */
export async function reobserveLocalExecutions(mission: Mission, store: MissionStore): Promise<Mission> {
  const eligible = (current: Mission) =>
    current.executionPolicy?.autoResume &&
    !["interrupted", "budget", "integrity"].includes(current.execution?.failureKind ?? "") &&
    current.operations?.runs.some(
      (run) => run.executionState === "unknown" && run.executionRecovery === "local-process",
    )
  if (!eligible(mission)) return mission
  const unlock = await store.lock(mission.id)
  try {
    const current = await store.load(mission.id)
    if (!eligible(current)) return current
    try {
      // The store reconciles only a matching marker whose process guard proved termination.
      await store.recoverProcesses(current.id, current)
    } catch (error) {
      // A live, reused or uninspectable process remains unknown and cannot be replayed.
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000)
      const previous = current.history.at(-1)
      if (previous?.stage !== "execution-reobservation-blocked" || previous.message !== message) {
        current.history.push({ at: new Date().toISOString(), stage: "execution-reobservation-blocked", message })
        await store.save(current)
      }
      return current
    }
    const unresolved = current.operations?.runs.some(
      (run) =>
        run.executionState === "unknown" ||
        (run.executionState === "running" && run.executionRecovery !== "local-process"),
    )
    if (!unresolved && !current.tasks.some((task) => task.effectState === "unknown") && current.supervision) {
      const reason =
        "Local process guards confirmed termination. The Chief must reassess the original work and checks before continuing."
      current.supervision.pendingRecovery ??= { reason }
      if (current.execution?.failureKind === "unknown-effect") {
        current.execution.failureKind = "environment"
        current.execution.pauseReason = reason
        current.error = reason
      }
      await store.save(current)
    }
    return current
  } finally {
    await unlock()
  }
}
