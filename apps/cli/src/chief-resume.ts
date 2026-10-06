import { automaticMissionRecovery } from "@agent-valley/core/chief/continuous-recovery"
import {
  executionPolicySchema,
  executionState,
  reconcileRunCost,
  resolveExternalEffect,
} from "@agent-valley/core/chief/execution"
import type { Mission } from "@agent-valley/core/chief/types"
import type { OrderOptions } from "./chief-config"

export function validateResumeOptions(goal: string | undefined, options: OrderOptions): void {
  const allowed = new Set([
    "resume",
    "worker",
    "supervise",
    "retry",
    "runs",
    "duration",
    "cost",
    "rounds",
    "resolveEffect",
    "effectResult",
    "accountRun",
    "accountCost",
  ])
  if (goal || Object.keys(options).some((key) => !allowed.has(key)))
    throw new Error(
      "Pass only --resume <id> with optional --retry, budget increases or effect reconciliation; the saved goal, Actors and checks stay fixed.",
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
  if (options.accountRun || options.accountCost !== undefined) {
    if (!options.accountRun || options.accountCost === undefined)
      throw new Error("Use --account-run <id> with --account-cost <usd> after inspecting billing.")
    if (!options.accountCost.trim()) throw new Error("--account-cost must be an explicit nonnegative USD amount.")
    reconcileRunCost(mission, options.accountRun, Number(options.accountCost))
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
    state.retries = 0
    state.crashRestarts = 0
    delete state.pauseReason
    delete state.nextRunAt
    delete state.failureKind
    if (mission.supervision) mission.supervision.stalledRounds = 0
    mission.status = "pending"
    mission.history.push({
      at: state.interventionAt,
      stage: "operator-intervention",
      message:
        "Operator resumed the original goal with reconciled effects or adjusted execution limits; prior decisions and checks were retained.",
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
