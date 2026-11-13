import { cancelledWorkRunProofs } from "./cancelled-work-run"
import type { OperatingRun, ProviderHealth } from "./operations"
import type { Mission } from "./types"

export const ACTOR_COOLDOWN_BASE_MS = 15 * 60_000
export const ACTOR_COOLDOWN_MAX_MS = 6 * 60 * 60_000
export const ACTOR_PROBE_GRACE_MS = 60_000

export interface ActorRoute {
  actorType: string
  model?: string
}
export interface ProviderHealthEvidence extends ActorRoute {
  providerHealth: ProviderHealth
}
export interface ActorRouteHealth {
  state: "ready" | "cooling" | "probe-in-flight" | "unknown"
  consecutiveFailures: number
  retryAt?: string
  reason: string
}

const healthStages = new Set<OperatingRun["stage"]>(["work", "review", "gate-review", "final-review"])
const key = (route: ActorRoute) => JSON.stringify([route.actorType, route.model ?? null])

/**
 * Local validation, coordinator interruption and the framework's own attempt deadline do not establish
 * an Actor transport failure: a long task killed at timeoutSec says nothing about provider health, and
 * counting it idled healthy routes for a 15-minute cooldown.
 */
function frameworkFailure(reason: string | undefined): boolean {
  return (
    !!reason &&
    /OMA completion evidence failed|Coordinator process ended before usage could be reconciled|Order interrupted\. Resume the saved mission|Operator stopped the order|Mission interrupted\.|OS-owned service is shutting down|Agent timed out after \d+s|Agent stalled: no activity for \d+s|\b(?:ENOENT|EACCES|ENOSPC)\b|command not found|verification command|verifyCommand/i.test(
      reason,
    )
  )
}

function nativeOutcome(run: OperatingRun): "passed" | "failed" | undefined {
  if (run.nativeOutcome === "cancelled") return undefined
  if (run.nativeOutcome === "passed") return "passed"
  // A framework-attested failure (attempt deadline, inactivity stall, local validation, operator interruption) does not
  // establish a provider transport failure even when the native attempt settled as failed.
  if (run.nativeOutcome === "failed") return frameworkFailure(run.evidence) ? undefined : "failed"
  // Acceptance rejection changes the work verdict after a successful native execution.
  if (run.outcome !== "failed") return "passed"
  if (run.executionState === "settled" && !frameworkFailure(run.evidence)) return "failed"
  return undefined
}

function cooldownMs(failures: number): number {
  return Math.min(ACTOR_COOLDOWN_MAX_MS, ACTOR_COOLDOWN_BASE_MS * 2 ** Math.min(5, failures - 1))
}

function cooldownUntil(health: ProviderHealth): number {
  return Math.max(
    Date.parse(health.lastOutcomeAt) + cooldownMs(health.consecutiveFailures),
    Date.parse(health.cooldownUntil ?? "") || 0,
  )
}

/** Fold only native execution history; task IDs, replans and operator retries are not reset points. */
export function aggregateProviderHealth(mission: Mission): ProviderHealthEvidence[] {
  const evidence = new Map<string, ProviderHealthEvidence>()
  const seedTimes = new Map<string, number>()
  for (const route of mission.operations?.routingEvidence ?? [])
    if (route.providerHealth) {
      evidence.set(key(route), {
        actorType: route.actorType,
        ...(route.model ? { model: route.model } : {}),
        providerHealth: { ...route.providerHealth },
      })
      seedTimes.set(key(route), Date.parse(route.providerHealth.lastOutcomeAt))
    }
  const cancelled = cancelledWorkRunProofs(mission)
  const runs = (mission.operations?.runs ?? [])
    .filter((run) => healthStages.has(run.stage) && !cancelled.has(run.runId))
    .filter((run) => run.executionState !== "unknown" && run.executionState !== "running")
    .filter((run) => {
      const start = Date.parse(run.startedAt)
      const finish = Date.parse(run.finishedAt ?? "")
      return Number.isFinite(start) && Number.isFinite(finish) && finish >= start
    })
    .sort((a, b) => Date.parse(a.finishedAt ?? "") - Date.parse(b.finishedAt ?? ""))
  for (const run of runs) {
    const outcome = nativeOutcome(run)
    if (!outcome || !run.finishedAt) continue
    const previous = evidence.get(key(run))?.providerHealth
    // A saved seed can already contain these exact local runs after a checkpoint.
    if (Date.parse(run.finishedAt) <= (seedTimes.get(key(run)) ?? -Infinity)) continue
    const failures = outcome === "failed" ? (previous?.consecutiveFailures ?? 0) + 1 : 0
    evidence.set(key(run), {
      actorType: run.actorType,
      ...(run.model ? { model: run.model } : {}),
      providerHealth: {
        consecutiveFailures: failures,
        lastOutcomeAt: run.finishedAt,
        ...(failures
          ? { cooldownUntil: new Date(Date.parse(run.finishedAt) + cooldownMs(failures)).toISOString() }
          : {}),
      },
    })
  }
  return [...evidence.values()]
}

/** Requested native defaults remain one bucket even when the CLI reports a different actual model. */
export function actorRouteHealth(mission: Mission, requested: ActorRoute, now = Date.now()): ActorRouteHealth {
  const health = aggregateProviderHealth(mission).find((route) => key(route) === key(requested))?.providerHealth
  const consecutiveFailures = health?.consecutiveFailures ?? 0
  const base = { consecutiveFailures }
  const runs = (mission.operations?.runs ?? []).filter(
    (run) => healthStages.has(run.stage) && key(run) === key(requested),
  )
  const uncertain = runs.some((run) => {
    const start = Date.parse(run.startedAt)
    const finish = Date.parse(run.finishedAt ?? "")
    return (
      run.executionState === "unknown" ||
      !Number.isFinite(start) ||
      (run.executionState !== "running" && (!Number.isFinite(finish) || finish < start)) ||
      (run.executionState === "running" && run.finishedAt !== null)
    )
  })
  if (!Number.isFinite(now) || uncertain)
    return {
      ...base,
      state: "unknown",
      reason: "Actor execution outcome is uncertain. Reconcile the saved run before retrying.",
    }
  const active = runs.filter((run) => run.executionState === "running")
  if (consecutiveFailures && active.length) {
    const timeout = Math.max(0, mission.timeoutSec) * 1000
    const retry = Math.max(
      now + ACTOR_PROBE_GRACE_MS,
      ...active.map((run) => Date.parse(run.startedAt) + timeout + ACTOR_PROBE_GRACE_MS),
    )
    return {
      ...base,
      state: "probe-in-flight",
      retryAt: new Date(retry).toISOString(),
      reason: "An Actor recovery probe is already running. Wait for its terminal result before another probe.",
    }
  }
  if (health && consecutiveFailures && now < cooldownUntil(health)) {
    const retryAt = new Date(cooldownUntil(health)).toISOString()
    return {
      ...base,
      state: "cooling",
      retryAt,
      reason: `Actor route has ${consecutiveFailures} consecutive execution failures; cooldown ends at ${retryAt}.`,
    }
  }
  return {
    ...base,
    state: "ready",
    reason: consecutiveFailures
      ? "Actor cooldown elapsed; allow one recovery probe."
      : "Actor route has no unresolved execution failure cooldown.",
  }
}
