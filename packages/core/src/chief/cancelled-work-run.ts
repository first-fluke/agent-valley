import type { OperatingRun } from "./operations"
import type { Mission } from "./types"

type CancellationProof = NonNullable<OperatingRun["routingExclusion"]>
const cancellationMessages = new Set([
  "Operator stopped the order. Its checks and worktree were retained; repair any interrupted effects before resuming with --retry.",
  "Mission interrupted. Its checks, budget and child workspace records were retained for resume.",
  "The OS-owned service is shutting down. Re-observe the saved execution before continuing the same goal within its original limits.",
])

function settledFailure(run: OperatingRun): boolean {
  return (
    run.stage === "work" &&
    !!run.taskId &&
    run.outcome === "failed" &&
    run.executionState === "settled" &&
    run.executionRecovery === "local-process" &&
    !run.evidence?.trim() &&
    Number.isFinite(Date.parse(run.startedAt)) &&
    Number.isFinite(Date.parse(run.finishedAt ?? "")) &&
    Date.parse(run.finishedAt ?? "") >= Date.parse(run.startedAt)
  )
}

/** Archived outcomes carry explicit proof; old failed outcomes are never reinterpreted from prose. */
export function archivedWorkCancellation(run: OperatingRun): CancellationProof | undefined {
  const proof = run.routingExclusion
  if (
    settledFailure(run) &&
    proof?.reason === "coordinator-cancelled" &&
    Date.parse(proof.dispatchAt) <= Date.parse(run.startedAt) &&
    Date.parse(proof.pauseAt) >= Date.parse(run.finishedAt ?? "")
  )
    return proof
}

/** Only a uniquely enclosed native dispatch with no intervening result establishes legacy cancellation. */
export function cancelledWorkRunProofs(mission: Mission): Map<string, CancellationProof> {
  const runs = mission.operations?.runs ?? []
  const history = mission.history ?? []
  const proofs = new Map<string, CancellationProof>()
  for (const run of runs) {
    const proof = archivedWorkCancellation(run)
    if (proof) proofs.set(run.runId, proof)
  }
  for (const [pauseIndex, pause] of history.entries()) {
    if (pause.stage !== "paused" || pause.taskId || !cancellationMessages.has(pause.message)) continue
    const pausedAt = Date.parse(pause.at)
    if (!Number.isFinite(pausedAt)) continue
    for (const run of runs) {
      if (!settledFailure(run) || Date.parse(run.finishedAt ?? "") > pausedAt) continue
      const state = mission.tasks?.find((task) => task.id === run.taskId)
      if (state?.effectState === "running" || state?.effectState === "unknown") continue
      const dispatchIndex = history.findLastIndex((entry, index) => {
        const prefix = `Running ${run.taskId} with ${run.actorId}, attempt `
        return (
          index < pauseIndex &&
          entry.stage === "work" &&
          entry.taskId === run.taskId &&
          entry.message.startsWith(prefix) &&
          /^[1-9]\d*\.$/.test(entry.message.slice(prefix.length)) &&
          Date.parse(entry.at) <= Date.parse(run.startedAt)
        )
      })
      const dispatch = history[dispatchIndex]
      if (!dispatch) continue
      const dispatchedAt = Date.parse(dispatch.at)
      if (
        runs.filter((entry) => {
          const start = Date.parse(entry.startedAt)
          if (!Number.isFinite(start)) return true
          if (start > pausedAt) return false
          const finish = Date.parse(entry.finishedAt ?? "")
          return !Number.isFinite(finish) || finish >= dispatchedAt
        }).length !== 1
      )
        continue
      const intermediate = history.slice(dispatchIndex + 1, pauseIndex)
      const uninterrupted = intermediate.every((entry) => {
        if (entry.stage === "skill-compatibility") return true
        if (entry.stage !== "oma-dispatch" || entry.taskId !== run.taskId) return false
        try {
          const record = JSON.parse(entry.message) as { attemptId?: string; actorId?: string }
          return record.attemptId === run.runId && record.actorId === run.actorId
        } catch {
          return false
        }
      })
      if (uninterrupted)
        proofs.set(run.runId, { reason: "coordinator-cancelled", dispatchAt: dispatch.at, pauseAt: pause.at })
    }
  }
  return proofs
}
