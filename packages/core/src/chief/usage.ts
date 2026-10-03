import type { RunAttempt } from "../domain/models"
import type { OperatingRun } from "./operations"
import type { ChiefStage, Mission, Persona } from "./types"

export function startOperatingRun(
  mission: Mission,
  actor: Persona,
  attempt: RunAttempt,
  stage: ChiefStage,
  taskId?: string,
  routingReason?: string,
): OperatingRun {
  mission.operations ??= { runs: [], routingEvidence: [], reviewDecisions: [] }
  const entry: OperatingRun = {
    runId: attempt.id,
    ...(taskId ? { taskId } : {}),
    stage,
    actorId: actor.id,
    actorType: actor.agentType,
    ...(actor.model ? { model: actor.model } : {}),
    startedAt: attempt.startedAt,
    finishedAt: null,
    elapsedMs: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    outcome: "pending",
    ...(routingReason ? { routingReason } : {}),
  }
  mission.operations.runs.push(entry)
  return entry
}

const tokens = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null

export function finishOperatingRun(mission: Mission, entry: OperatingRun, attempt: RunAttempt, failed = false): void {
  entry.finishedAt = attempt.finishedAt ?? new Date().toISOString()
  const elapsed = Date.parse(entry.finishedAt) - Date.parse(entry.startedAt)
  entry.elapsedMs = Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null
  const usage = attempt.tokenUsage
  entry.costUsd = null
  delete entry.actualModel
  entry.inputTokens = tokens(usage?.input)
  entry.outputTokens = tokens(usage?.output)
  if (usage?.model) entry.actualModel = usage.model.slice(0, 2_000)
  const candidate = mission.operatingPolicy?.routing?.candidates.find(
    (item) => item.actorType === entry.actorType && item.model === entry.model,
  )
  if (
    candidate?.inputPerMillionUsd !== undefined &&
    candidate.outputPerMillionUsd !== undefined &&
    entry.inputTokens !== null &&
    entry.outputTokens !== null &&
    (!entry.model || !entry.actualModel || entry.model === entry.actualModel)
  ) {
    const estimate =
      (entry.inputTokens * candidate.inputPerMillionUsd + entry.outputTokens * candidate.outputPerMillionUsd) /
      1_000_000
    entry.costUsd = Number.isFinite(estimate) ? estimate : null
  }
  entry.outcome = failed ? "failed" : entry.stage === "work" ? "pending" : "passed"
}
