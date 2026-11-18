import { automaticMissionRecovery } from "@agent-valley/core/chief/continuous-recovery"
import {
  executionPolicySchema,
  executionState,
  reconcileRunCost,
  resolveExternalEffect,
} from "@agent-valley/core/chief/execution"
import { finalCriteria } from "@agent-valley/core/chief/goal-evidence"
import type { Mission } from "@agent-valley/core/chief/types"
import type { OrderOptions } from "./chief-config"
import { deliveryResumeKeys } from "./chief-delivery-resume"

export function validateResumeOptions(goal: string | undefined, options: OrderOptions): void {
  const allowed = new Set([
    "resume",
    "worker",
    "supervise",
    "service",
    "retry",
    "note",
    "waiveCriterion",
    "waiveReason",
    "timeout",
    "runs",
    "duration",
    "cost",
    "rounds",
    "resolveEffect",
    "effectResult",
    "accountRun",
    "accountCost",
    ...deliveryResumeKeys,
  ])
  if (goal || Object.keys(options).some((key) => !allowed.has(key)))
    throw new Error(
      "Pass only --resume <id> with optional --retry, budget increases, effect reconciliation or explicit delivery activation; the saved goal, Actors and checks stay fixed.",
    )
}

export function applyResumeOptions(mission: Mission, goal: string | undefined, options: OrderOptions): void {
  validateResumeOptions(goal, options)
  const integer = (value: string, minimum: number, maximum: number, name: string) => {
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum)
      throw new Error(`${name} must be an integer between ${minimum} and ${maximum}; spent budget cannot be reset.`)
    return parsed
  }
  let changed = options.retry === true
  const note = options.note?.trim()
  if (options.note !== undefined && !note)
    throw new Error("--note needs text describing what changed since the last attempt.")
  if (note) {
    if (note.length > 4_000)
      throw new Error("--note must stay within 4000 characters; point to a file for longer context.")
    mission.operatorNotes = [...(mission.operatorNotes ?? []), { at: new Date().toISOString(), text: note }]
    changed = true
  }
  if (options.waiveCriterion !== undefined || options.waiveReason !== undefined) {
    const criteria = finalCriteria(mission)
    const index = Number(options.waiveCriterion)
    const reason = options.waiveReason?.trim()
    if (!Number.isInteger(index) || index < 1 || index > criteria.length || !reason || reason.length > 1_000)
      throw new Error(
        `--waive-criterion takes the number of a success criterion together with --waive-reason <text of at most 1000 characters>. Criteria: ${criteria.map((criterion, position) => `${position + 1}. ${criterion.slice(0, 160)}`).join(" | ") || "none recorded"}`,
      )
    const criterion = criteria[index - 1] as string
    const at = new Date().toISOString()
    mission.criterionWaivers = [
      ...(mission.criterionWaivers ?? []).filter((waiver) => waiver.criterion !== criterion),
      { at, criterion, reason },
    ]
    mission.history.push({
      at,
      stage: "criterion-waived",
      message: `Operator accepted success criterion ${index} as unmet in this mission: ${reason} The criterion is still assessed and reported; it no longer holds the mission open.`,
    })
    changed = true
  }
  if (options.accountRun || options.accountCost !== undefined) {
    if (!options.accountRun || options.accountCost === undefined)
      throw new Error("Use --account-run <id> with --account-cost <usd> after inspecting billing.")
    if (!options.accountCost.trim()) throw new Error("--account-cost must be an explicit nonnegative USD amount.")
    reconcileRunCost(mission, options.accountRun, Number(options.accountCost))
    changed = true
  }
  if (options.timeout) {
    mission.timeoutSec = integer(options.timeout, mission.timeoutSec, 86_400, "--timeout")
    changed = true
  }
  if (options.runs || options.duration || options.cost || options.rounds) {
    mission.executionPolicy ??= executionPolicySchema.parse({})
    if (options.runs)
      mission.executionPolicy.maxRuns = integer(
        options.runs,
        Math.max(mission.executionPolicy.maxRuns, (mission.execution?.runsStarted ?? 0) + 1),
        2_000,
        "--runs",
      )
    if (options.duration)
      mission.executionPolicy.maxDurationSec = integer(
        options.duration,
        mission.executionPolicy.maxDurationSec,
        604_800,
        "--duration",
      )
    if (options.cost) {
      const cost = Number(options.cost)
      if (!Number.isFinite(cost) || cost <= (mission.executionPolicy.maxEstimatedCostUsd ?? 0))
        throw new Error("--cost must increase the positive configured-price estimate limit.")
      mission.executionPolicy.maxEstimatedCostUsd = cost
    }
    if (options.rounds && mission.supervision)
      mission.supervision.maxRounds = integer(
        options.rounds,
        Math.max(mission.supervision.maxRounds, mission.supervision.rounds + 1),
        50,
        "--rounds",
      )
    changed = true
  }
  if (options.resolveEffect || options.effectResult) {
    if (!options.resolveEffect || !["completed", "not-applied"].includes(options.effectResult ?? ""))
      throw new Error(
        "Use --resolve-effect <task-id> with --effect-result completed|not-applied after inspecting the external destination.",
      )
    if (!options.effectResult) throw new Error("Set --effect-result after inspecting the destination.")
    resolveExternalEffect(mission, options.resolveEffect, options.effectResult)
    changed = true
  }
  if (changed) {
    const state = executionState(mission)
    state.interventionAt = new Date().toISOString()
    delete state.pauseReason
    delete state.nextRunAt
    delete state.failureKind
    if (mission.supervision) {
      mission.supervision.stalledRounds = 0
      // The operator looked at the repeated final-review failure; the next one may be repaired once more.
      delete mission.supervision.finalReviewFailures
    }
    mission.status = "pending"
    mission.history.push({
      at: state.interventionAt,
      stage: "operator-intervention",
      message: note
        ? `Operator resumed the original goal with a note for Actors and the Chief; prior decisions and checks were retained. Note: ${note}`
        : "Operator resumed the original goal with reconciled effects or adjusted execution limits; prior decisions and checks were retained.",
    })
  } else if (mission.status === "paused" || mission.status === "failed") {
    const recovery = automaticMissionRecovery(mission)
    if (recovery.retry && (!recovery.waitUntil || Date.parse(recovery.waitUntil) <= Date.now())) {
      mission.status = "pending"
      mission.history.push({
        at: new Date().toISOString(),
        stage: "chief-resume",
        message: `Continuing the Chief's saved recovery without changing its limits or spent usage: ${recovery.reason}`,
      })
    }
  }
}
