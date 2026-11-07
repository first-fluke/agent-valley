import { availableActorRoutes } from "./actor-availability"
import { aggregateProviderHealth } from "./actor-health"
import { cancelledWorkRunProofs } from "./cancelled-work-run"
import { isNativeAgentTimeout } from "./execution"
import { DEFAULT_EVIDENCE_WINDOW, type RouteEvidence, type RoutingCandidate } from "./operations"
import { appendRouteOutcome, routePrice, routeQuality } from "./route-quality"
import type { Mission, Persona } from "./types"

export const routeKey = (entry: { actorType: string; model?: string }) => `${entry.actorType}\u0000${entry.model ?? ""}`

/** Include unsuccessful attempts in successful-deliverable cost; unknown costs stay unknown. */
export function routeEvidence(mission: Mission): RouteEvidence[] {
  const evidence = new Map<string, RouteEvidence>()
  const window = mission.operatingPolicy?.routing?.evidenceWindow ?? DEFAULT_EVIDENCE_WINDOW
  const cancelled = cancelledWorkRunProofs(mission)
  for (const item of mission.operations?.routingEvidence ?? []) evidence.set(routeKey(item), { ...item })
  for (const run of mission.operations?.runs ?? []) {
    if (run.stage !== "work" || run.outcome === "pending") continue
    const key = routeKey(run)
    const item = evidence.get(key) ?? {
      actorType: run.actorType,
      ...(run.model ? { model: run.model } : {}),
      samples: 0,
      successes: 0,
      totalCostUsd: 0,
      successfulDeliverableCostUsd: null,
    }
    // A confirmed deadline cutoff is not a deliverable-quality verdict; spent cost still counts.
    if (!cancelled.has(run.runId) && run.nativeOutcome !== "cancelled" && !isNativeAgentTimeout(run.evidence ?? "")) {
      item.samples += 1
      appendRouteOutcome(item, { at: run.finishedAt ?? run.startedAt, outcome: run.outcome }, window)
    }
    if (run.outcome === "passed") item.successes += 1
    item.totalCostUsd = item.totalCostUsd === null || run.costUsd === null ? null : item.totalCostUsd + run.costUsd
    item.successfulDeliverableCostUsd =
      item.successes && item.totalCostUsd !== null ? item.totalCostUsd / item.successes : null
    evidence.set(key, item)
  }
  for (const health of aggregateProviderHealth(mission)) {
    if (!health.providerHealth.consecutiveFailures && !evidence.get(routeKey(health))?.providerHealth) continue
    const item = evidence.get(routeKey(health)) ?? {
      actorType: health.actorType,
      ...(health.model ? { model: health.model } : {}),
      samples: 0,
      successes: 0,
      totalCostUsd: 0,
      successfulDeliverableCostUsd: null,
    }
    evidence.set(routeKey(health), { ...item, providerHealth: health.providerHealth })
  }
  return [...evidence.values()]
}

function readyWorkCandidates(mission: Mission): RoutingCandidate[] {
  const ready = mission.operatingPolicy?.readyActors ?? mission.availableAgents ?? []
  const exhausted = unavailableProviders(mission.handoff)
  const candidates = (mission.operatingPolicy?.routing?.candidates ?? []).filter(
    (candidate) => ready.includes(candidate.actorType) && !exhausted.has(candidate.actorType),
  )
  if (candidates.length || !exhausted.size) return candidates
  // An authenticated exhaustion fallback also remains available to subsequent tasks.
  return [
    ...new Map(
      Object.values(mission.handoff?.routes ?? {})
        .filter((route) => !exhausted.has(route.agentType))
        .map((route) => {
          const candidate = { actorType: route.agentType, ...(route.model ? { model: route.model } : {}) }
          return [routeKey(candidate), candidate] as const
        }),
    ).values(),
  ]
}

export function workActorCandidates(
  mission: Mission,
  actor: Persona,
  preserveExplicit = false,
): Array<{ actorType: string; model?: string }> {
  const routing = mission.operatingPolicy?.routing
  if (!routing || actor.id === mission.chiefId || (!mission.availableAgents && (actor.model || preserveExplicit)))
    return [{ actorType: actor.agentType, model: actor.model }]
  return readyWorkCandidates(mission)
}

export function selectWorkActor(
  mission: Mission,
  actor: Persona,
  taskId?: string,
  compatibleRoutes?: ReadonlySet<string>,
): { actor: Persona; reason: string } {
  const routing = mission.operatingPolicy?.routing
  if (!routing || actor.id === mission.chiefId || (!mission.availableAgents && (actor.model || compatibleRoutes))) {
    if (compatibleRoutes && !compatibleRoutes.has(routeKey({ actorType: actor.agentType, model: actor.model })))
      throw new Error(
        "Skill compatibility required: the configured Actor/model has no current passing evidence. Refresh oma.skill_compatibility.report_path in av.yaml; explicit Actors are not rerouted.",
      )
    availableActorRoutes(mission, [{ actorType: actor.agentType, model: actor.model }])
    return { actor, reason: "Preserved the configured Actor and explicit model." }
  }
  const candidates = readyWorkCandidates(mission)
  if (!candidates.length)
    throw new Error(
      "No configured work routing candidate is ready. Install/login a candidate CLI or update chief.routing.candidates in av.yaml.",
    )
  const compatiblePool = compatibleRoutes
    ? candidates.filter((candidate) => compatibleRoutes.has(routeKey(candidate)))
    : candidates
  if (!compatiblePool.length)
    throw new Error(
      "Skill compatibility required: no ready work candidate has current passing installed evidence. Refresh oma.skill_compatibility.report_path in av.yaml with explicit models before retrying.",
    )
  const compatible = availableActorRoutes(mission, compatiblePool)
  const evidence = routeEvidence(mission)
  const window = routing.evidenceWindow ?? DEFAULT_EVIDENCE_WINDOW
  const observed = (candidate: RoutingCandidate) => evidence.find((item) => routeKey(item) === routeKey(candidate))
  const eligible = compatible.filter((candidate) => {
    const quality = routeQuality(observed(candidate), window)
    return quality.samples < routing.minSamples || quality.successes / quality.samples >= routing.minSuccessRate
  })
  const qualified = eligible
    .map((candidate) => ({ candidate, evidence: observed(candidate) }))
    .filter(
      (
        item,
      ): item is {
        candidate: RoutingCandidate
        evidence: RouteEvidence & { successfulDeliverableCostUsd: number }
      } => {
        if (item.evidence === undefined || item.evidence.successfulDeliverableCostUsd === null) return false
        const quality = routeQuality(item.evidence, window)
        return quality.samples >= routing.minSamples && quality.successes / quality.samples >= routing.minSuccessRate
      },
    )
    .sort((a, b) => a.evidence.successfulDeliverableCostUsd - b.evidence.successfulDeliverableCostUsd)
  const measured = qualified.at(0)
  const initial = measured?.candidate ?? [...eligible].sort((a, b) => routePrice(a) - routePrice(b)).at(0)
  const cancelled = cancelledWorkRunProofs(mission)
  const taskRuns = (mission.operations?.runs ?? []).filter(
    (run) =>
      run.stage === "work" && run.taskId === taskId && !cancelled.has(run.runId) && run.nativeOutcome !== "cancelled",
  )
  if (hasUnreviewedRoutingProbe(mission, taskId, taskRuns))
    throw new Error(
      "This task has an unreviewed bounded routing probe. Resume its retained review or obtain a later Chief repair decision before dispatching more work.",
    )
  const failed = new Set<string>()
  for (let i = taskRuns.length - 1; i >= 0; i--) {
    const run = taskRuns[i]
    if (!run) continue
    if (run.outcome === "passed") break
    if (run.outcome === "failed" || run.outcome === "rejected") failed.add(routeKey(run))
  }
  const ordered = [
    ...(initial ? [initial] : []),
    ...eligible
      .filter((item) => !initial || routeKey(item) !== routeKey(initial))
      .sort((a, b) => routePrice(a) - routePrice(b)),
  ]
  const selected = ordered.find((item) => !failed.has(routeKey(item)))
  if (!selected) {
    const probe = boundedWorkRoute(mission, taskId, compatible, evidence, taskRuns, failed, routeKey)
    if (probe)
      return {
        actor: { ...actor, agentType: probe.candidate.actorType, model: probe.candidate.model },
        reason: probe.reason,
      }
    const remaining = compatible.filter((candidate) => !failed.has(routeKey(candidate)))
    const degraded = degradedWorkRoute(mission, taskId, remaining, evidence, taskRuns, window, routeKey)
    if (degraded)
      return {
        actor: { ...actor, agentType: degraded.candidate.actorType, model: degraded.candidate.model },
        reason: degraded.reason,
      }
    throw new Error(
      remaining.length
        ? "No routing candidate meets the measured minimum success rate and this task has no remaining bounded probe. Inspect its saved failures and Chief repair checkpoint before continuing."
        : "Every configured routing candidate failed this task. Its bounded probes are spent; obtain a Chief repair decision or reconcile the recorded failures before continuing.",
    )
  }
  const reason = failed.size
    ? `Escalated after ${failed.size} actually rejected/failed route(s) for this task.`
    : measured
      ? `Selected observed successful-deliverable cost after ${measured.evidence.samples} real samples.`
      : Number.isFinite(routePrice(selected))
        ? "No qualifying measured route; selected the lowest configured input/output price sum (not a measured run cost)."
        : "No qualifying measured cost or complete prices; selected configured candidate order with unknown cost."
  return { actor: { ...actor, agentType: selected.actorType, model: selected.model }, reason }
}

export function latestWorkRun(mission: Mission, taskId: string) {
  return mission.operations?.runs.findLast((run) => run.stage === "work" && run.taskId === taskId)
}

export function recordTaskVerdict(mission: Mission, taskId: string, passed: boolean, evidence: string): void {
  const run = latestWorkRun(mission, taskId)
  if (run?.executionState === "unknown") return
  const decision = mission.operations?.reviewDecisions.findLast(
    (entry) => !entry.gateId && entry.taskId === taskId && (!run || entry.runId === run.runId),
  )
  const reviewRun = mission.operations?.runs.findLast((entry) => entry.stage === "review" && entry.taskId === taskId)
  if (decision) decision.outcome = reviewRun?.outcome === "failed" ? "failed" : passed ? "passed" : "rejected"
  if (!run || run.outcome === "failed") return
  run.outcome = passed ? "passed" : "rejected"
  run.evidence = evidence.slice(0, 2_000) || "Independent review did not provide acceptance evidence."
  run.fingerprint = mission.fingerprint
}

import { boundedWorkRoute, degradedWorkRoute, hasUnreviewedRoutingProbe } from "./bounded-work-routing"
import { unavailableProviders } from "./handoff-contract"
