import type { RouteEvidence, RoutingCandidate } from "./operations"
import type { Mission, Persona } from "./types"

export const routeKey = (entry: { actorType: string; model?: string }) => `${entry.actorType}\u0000${entry.model ?? ""}`

/** Include unsuccessful attempts in successful-deliverable cost; unknown costs stay unknown. */
export function routeEvidence(mission: Mission): RouteEvidence[] {
  const evidence = new Map<string, RouteEvidence>()
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
    item.samples += 1
    if (run.outcome === "passed") item.successes += 1
    item.totalCostUsd = item.totalCostUsd === null || run.costUsd === null ? null : item.totalCostUsd + run.costUsd
    item.successfulDeliverableCostUsd =
      item.successes && item.totalCostUsd !== null ? item.totalCostUsd / item.successes : null
    evidence.set(key, item)
  }
  return [...evidence.values()]
}

function price(candidate: RoutingCandidate): number {
  return candidate.inputPerMillionUsd !== undefined && candidate.outputPerMillionUsd !== undefined
    ? candidate.inputPerMillionUsd + candidate.outputPerMillionUsd
    : Number.POSITIVE_INFINITY
}

export function workActorCandidates(
  mission: Mission,
  actor: Persona,
  preserveExplicit = false,
): Array<{ actorType: string; model?: string }> {
  const routing = mission.operatingPolicy?.routing
  if (!routing || actor.id === mission.chiefId || (!mission.availableAgents && (actor.model || preserveExplicit)))
    return [{ actorType: actor.agentType, model: actor.model }]
  const ready = mission.operatingPolicy?.readyActors ?? mission.availableAgents ?? []
  return routing.candidates.filter((candidate) => ready.includes(candidate.actorType))
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
    return { actor, reason: "Preserved the configured Actor and explicit model." }
  }
  const ready = mission.operatingPolicy?.readyActors ?? mission.availableAgents ?? []
  const candidates = routing.candidates.filter((candidate) => ready.includes(candidate.actorType))
  if (!candidates.length)
    throw new Error(
      "No configured work routing candidate is ready. Install/login a candidate CLI or update chief.routing.candidates in av.yaml.",
    )
  const compatible = compatibleRoutes
    ? candidates.filter((candidate) => compatibleRoutes.has(routeKey(candidate)))
    : candidates
  if (!compatible.length)
    throw new Error(
      "Skill compatibility required: no ready work candidate has current passing installed evidence. Refresh oma.skill_compatibility.report_path in av.yaml with explicit models before retrying.",
    )
  const evidence = routeEvidence(mission)
  const eligible = compatible.filter((candidate) => {
    const observed = evidence.find((item) => routeKey(item) === routeKey(candidate))
    return (
      !observed ||
      observed.samples < routing.minSamples ||
      observed.successes / observed.samples >= routing.minSuccessRate
    )
  })
  if (!eligible.length)
    throw new Error(
      "No routing candidate meets the measured minimum success rate. Inspect real failures or configure a new candidate before starting another mission.",
    )
  const qualified = eligible
    .map((candidate) => ({ candidate, evidence: evidence.find((item) => routeKey(item) === routeKey(candidate)) }))
    .filter(
      (
        item,
      ): item is { candidate: RoutingCandidate; evidence: RouteEvidence & { successfulDeliverableCostUsd: number } } =>
        item.evidence !== undefined &&
        item.evidence.samples >= routing.minSamples &&
        item.evidence.successes / item.evidence.samples >= routing.minSuccessRate &&
        item.evidence.successfulDeliverableCostUsd !== null,
    )
    .sort((a, b) => a.evidence.successfulDeliverableCostUsd - b.evidence.successfulDeliverableCostUsd)
  const measured = qualified.at(0)
  const initial = measured?.candidate ?? [...eligible].sort((a, b) => price(a) - price(b)).at(0)
  if (!initial) throw new Error("Restore a ready work routing candidate before continuing this mission.")
  const taskRuns = (mission.operations?.runs ?? []).filter((run) => run.stage === "work" && run.taskId === taskId)
  const failed = new Set<string>()
  for (let i = taskRuns.length - 1; i >= 0; i--) {
    const run = taskRuns[i]
    if (!run) continue
    if (run.outcome === "passed") break
    if (run.outcome === "failed" || run.outcome === "rejected") failed.add(routeKey(run))
  }
  const ordered = [
    initial,
    ...eligible.filter((item) => routeKey(item) !== routeKey(initial)).sort((a, b) => price(a) - price(b)),
  ]
  const selected = ordered.find((item) => !failed.has(routeKey(item)))
  if (!selected)
    throw new Error(
      "Every configured routing candidate failed this task. Inspect recorded reviews and work evidence before resuming; configure a new candidate or a new mission.",
    )
  const reason = failed.size
    ? `Escalated after ${failed.size} actually rejected/failed route(s) for this task.`
    : measured
      ? `Selected observed successful-deliverable cost after ${measured.evidence.samples} real samples.`
      : Number.isFinite(price(selected))
        ? "No qualifying measured route; selected the lowest configured input/output price sum (not a measured run cost)."
        : "No qualifying measured cost or complete prices; selected configured candidate order with unknown cost."
  return { actor: { ...actor, agentType: selected.actorType, model: selected.model }, reason }
}

export function latestWorkRun(mission: Mission, taskId: string) {
  return mission.operations?.runs.findLast((run) => run.stage === "work" && run.taskId === taskId)
}

export function recordTaskVerdict(mission: Mission, taskId: string, passed: boolean, evidence: string): void {
  const run = latestWorkRun(mission, taskId)
  const decision = mission.operations?.reviewDecisions.findLast(
    (entry) => entry.taskId === taskId && (!run || entry.runId === run.runId),
  )
  const reviewRun = mission.operations?.runs.findLast((entry) => entry.stage === "review" && entry.taskId === taskId)
  if (decision) decision.outcome = reviewRun?.outcome === "failed" ? "failed" : passed ? "passed" : "rejected"
  if (!run || run.outcome === "failed") return
  run.outcome = passed ? "passed" : "rejected"
  run.evidence = evidence.slice(0, 2_000) || "Independent review did not provide acceptance evidence."
  run.fingerprint = mission.fingerprint
}
