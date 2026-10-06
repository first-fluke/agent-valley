import { createHash } from "node:crypto"
import { z } from "zod"
import type { Mission } from "./types"

export const executionPolicySchema = z.strictObject({
  maxParallel: z.number().int().min(1).max(8).default(3),
  maxDurationSec: z.number().int().min(1).max(604_800).default(86_400),
  maxRuns: z.number().int().min(1).max(2_000).default(200),
  maxEstimatedCostUsd: z.number().finite().positive().optional(),
  maxRetries: z.number().int().min(0).max(10).default(3),
  retryDelayMs: z.number().int().min(10).max(300_000).default(1_000),
  autoResume: z.boolean().default(true),
})
export type ExecutionPolicy = z.infer<typeof executionPolicySchema>
export const executionStateSchema = z.strictObject({
  startedAt: z.iso.datetime(),
  runsStarted: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  crashRestarts: z.number().int().nonnegative().optional(),
  nextRunAt: z.iso.datetime().optional(),
  pauseReason: z.string().max(32_000).optional(),
  failureKind: z
    .enum([
      "authentication",
      "rate-limit",
      "provider",
      "environment",
      "implementation",
      "unknown-effect",
      "budget",
      "interrupted",
      "chief-wait",
      "chief-unavailable",
      "integrity",
    ])
    .optional(),
  progressKey: z.string().optional(),
  interventionAt: z.iso.datetime().optional(),
  costReconciliations: z
    .array(
      z.strictObject({
        runId: z.string().min(1).max(2_000),
        costUsd: z.number().finite().nonnegative(),
        at: z.iso.datetime(),
        authority: z.literal("operator-recorded"),
      }),
    )
    .max(2_000)
    .optional(),
})
export type ExecutionState = z.infer<typeof executionStateSchema>
export type FailureKind = NonNullable<ExecutionState["failureKind"]>

/** A saved Chief stop persists until a later explicit intervention; invalid dates fail closed. */
export function chiefRecoveryStopped(mission: Mission): boolean {
  const decision = mission.supervision?.decisions.at(-1)
  if (decision?.action !== "stop") return false
  const stoppedAt = Date.parse(decision.at)
  const intervenedAt = Date.parse(mission.execution?.interventionAt ?? "")
  return !Number.isFinite(stoppedAt) || !Number.isFinite(intervenedAt) || intervenedAt <= stoppedAt
}

export class MissionPause extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind,
    readonly nextRunAt?: string,
  ) {
    super(message)
  }
}

export function classifyFailure(reason: string): FailureKind {
  if (
    /unauthori[sz]ed|authentication|login required|log in|expired token|invalid.*(?:token|api.key)|\b401\b|\b403\b/i.test(
      reason,
    )
  )
    return "authentication"
  if (/rate.?limit|too many requests|\b429\b/i.test(reason)) return "rate-limit"
  if (
    /\b50[0234]\b|econnreset|econnrefused|etimedout|fetch failed|temporarily unavailable|overloaded|network error/i.test(
      reason,
    )
  )
    return "provider"
  if (/enoent|not found|missing.*(?:cli|command|dependency)|permission denied|eacces|enospc/i.test(reason))
    return "environment"
  return "implementation"
}

export function executionState(mission: Mission): ExecutionState {
  mission.execution ??= { startedAt: new Date().toISOString(), runsStarted: 0, retries: 0 }
  return mission.execution
}

export function finalizeAbandonedRuns(mission: Mission): void {
  for (const run of mission.operations?.runs ?? []) {
    if (run.finishedAt) continue
    run.finishedAt = new Date().toISOString()
    run.elapsedMs = Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt))
    run.outcome = "failed"
    run.costUsd = null
    run.inputTokens = null
    run.outputTokens = null
    run.evidence = "Coordinator process ended before usage could be reconciled; cost remains unknown."
  }
}

/** Money is a configured-price estimate. Unknown usage cannot establish headroom. */
export function assertExecutionBudget(mission: Mission, now = Date.now()): void {
  const policy = mission.executionPolicy
  if (!policy) return
  const state = executionState(mission)
  if (now - Date.parse(state.startedAt) >= policy.maxDurationSec * 1_000)
    throw new MissionPause(
      "Mission time limit reached. The original goal remains unresolved within its saved duration.",
      "budget",
    )
  if (state.runsStarted >= policy.maxRuns)
    throw new MissionPause(
      "Mission Actor call limit reached. The original goal remains unresolved within its saved call budget.",
      "budget",
    )
  if (policy.maxEstimatedCostUsd !== undefined) {
    const finished = mission.operations?.runs.filter((run) => run.finishedAt) ?? []
    const reconciled = new Map(state.costReconciliations?.map((entry) => [entry.runId, entry.costUsd]))
    if (finished.some((run) => run.costUsd === null && !reconciled.has(run.runId)))
      throw new MissionPause(
        "Cost headroom is unknown. Unresolved billing evidence prevents further calls; no zero-cost assumption was made.",
        "budget",
      )
    if (
      finished.reduce((sum, run) => sum + (run.costUsd ?? reconciled.get(run.runId) ?? 0), 0) >=
      policy.maxEstimatedCostUsd
    )
      throw new MissionPause(
        "Configured-price estimated cost limit reached. The goal remains unresolved within its saved cost budget.",
        "budget",
      )
  }
}

export function assertExecutionDeadline(mission: Mission, now = Date.now()): void {
  if (
    mission.executionPolicy &&
    now - Date.parse(executionState(mission).startedAt) >= mission.executionPolicy.maxDurationSec * 1_000
  )
    throw new MissionPause(
      "Mission time limit reached. The original goal remains unresolved within its saved duration.",
      "budget",
    )
}

export function reconcileRunCost(mission: Mission, runId: string, costUsd: number): void {
  const run = mission.operations?.runs.find((entry) => entry.runId === runId)
  if (!run?.finishedAt || run.costUsd !== null || !Number.isFinite(costUsd) || costUsd < 0)
    throw new Error("Select a finished run with unknown cost and provide a nonnegative observed USD amount.")
  const state = executionState(mission)
  state.costReconciliations = [
    ...(state.costReconciliations ?? []).filter((entry) => entry.runId !== runId),
    { runId, costUsd, at: new Date().toISOString(), authority: "operator-recorded" },
  ]
}

export function reserveExecutionRun(mission: Mission): void {
  assertExecutionBudget(mission)
  if (mission.executionPolicy) executionState(mission).runsStarted += 1
}

/** Workspace changes and real external observations both count as progress. */
export function progressKey(mission: Mission, fingerprint: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        fingerprint,
        metrics: mission.organizationContext?.metrics.map((metric) => ({
          id: metric.id,
          value: metric.value,
          timestamp: metric.timestamp,
        })),
        effects: mission.tasks.map((task) => ({ id: task.id, effectState: task.effectState })),
        containers: mission.containerObservation?.fingerprint,
      }),
    )
    .digest("hex")
}

export function pauseForFailure(mission: Mission, reason: string, taskId?: string): void {
  if (!mission.executionPolicy) return
  const task = mission.plan?.tasks.find((entry) => entry.id === taskId)
  const state = mission.tasks.find((entry) => entry.id === taskId)
  if (task?.effectScope === "external" && state?.effectState === "running") {
    state.effectState = "unknown"
    throw new MissionPause(
      `External effect for ${taskId} is uncertain. Its destination outcome has not been established; it will not be repeated.`,
      "unknown-effect",
    )
  }
  const kind = classifyFailure(reason)
  if (kind === "authentication" || kind === "environment") {
    if (mission.supervision) return
    throw new MissionPause(`${reason} Required source access is unavailable; the goal remains unresolved.`, kind)
  }
  if (kind !== "rate-limit" && kind !== "provider") return
  const execution = executionState(mission)
  if (execution.retries >= mission.executionPolicy.maxRetries) {
    if (mission.supervision) return
    throw new MissionPause(`${reason} Automatic retries exhausted; the goal remains unresolved.`, kind)
  }
  execution.retries += 1
  const delay = Math.min(300_000, mission.executionPolicy.retryDelayMs * 2 ** (execution.retries - 1))
  throw new MissionPause(reason, kind, new Date(Date.now() + delay).toISOString())
}

export function recordPause(mission: Mission, pause: MissionPause): void {
  const state = executionState(mission)
  state.pauseReason = pause.message
  state.failureKind = pause.kind
  if (pause.nextRunAt) state.nextRunAt = pause.nextRunAt
  else delete state.nextRunAt
  mission.status = pause.nextRunAt ? "waiting" : "paused"
  mission.error = pause.message
}

export function resolveExternalEffect(mission: Mission, taskId: string, result: "completed" | "not-applied"): void {
  const task = mission.plan?.tasks.find((entry) => entry.id === taskId)
  const state = mission.tasks.find((entry) => entry.id === taskId)
  if (task?.effectScope !== "external" || !state || !["running", "unknown"].includes(state.effectState ?? ""))
    throw new Error("The selected task has no uncertain external effect. Inspect av missions before resolving it.")
  state.effectState = result === "completed" ? "completed" : "not-started"
  state.status = "pending"
  state.output =
    result === "completed"
      ? "Operator confirmed the external effect completed; inspect the actual destination during review."
      : undefined
  mission.history.push({
    at: new Date().toISOString(),
    stage: "effect-resolved",
    taskId,
    message: `Operator reconciled external effect: ${result}.`,
  })
}
