import { createHash } from "node:crypto"
import type { OperatingRun, RouteEvidence, RoutingCandidate } from "./operations"
import type { Mission, SupervisionDecision } from "./types"

function repairDecision(mission: Mission, taskId: string | undefined, taskRuns: OperatingRun[]) {
  return mission.supervision?.decisions.findLast(
    (entry) =>
      ["repair", "reassign", "replan"].includes(entry.action) &&
      (!entry.taskId || entry.taskId === taskId) &&
      entry.round > 0 &&
      entry.round <= (mission.supervision?.maxRounds ?? 0) &&
      entry.round <= (mission.supervision?.rounds ?? 0) &&
      Number.isFinite(Date.parse(entry.at)) &&
      taskRuns.some(
        (run) =>
          Number.isFinite(Date.parse(run.finishedAt ?? "")) && Date.parse(run.finishedAt ?? "") < Date.parse(entry.at),
      ),
  )
}

function unreviewed(run: OperatingRun, decision: SupervisionDecision | undefined): boolean {
  const finished = Date.parse(run.finishedAt ?? "")
  return run.outcome === "pending" && (!decision || !Number.isFinite(finished) || finished >= Date.parse(decision.at))
}

export function hasUnreviewedRoutingProbe(
  mission: Mission,
  taskId: string | undefined,
  taskRuns: OperatingRun[],
): boolean {
  const decision = repairDecision(mission, taskId, taskRuns)
  return taskRuns.some((run) => run.routingReason?.startsWith("Bounded routing probe ") && unreviewed(run, decision))
}

/** Quality is preferred; a closed fixed pool may probe each route once per saved repair checkpoint. */
export function boundedWorkRoute(
  mission: Mission,
  taskId: string | undefined,
  candidates: RoutingCandidate[],
  evidence: RouteEvidence[],
  taskRuns: OperatingRun[],
  failed: ReadonlySet<string>,
  routeKey: (route: { actorType: string; model?: string }) => string,
): { candidate: RoutingCandidate; reason: string } | undefined {
  if (!taskId) return
  const task = mission.plan?.tasks.find((entry) => entry.id === taskId)
  const state = mission.tasks.find((entry) => entry.id === taskId)
  if (!task || !state || state.status === "completed" || (state.repairRound ?? 0) > mission.maxRepairs) return
  if (
    mission.tasks.some((entry) => entry.effectState === "unknown" || entry.effectState === "running") ||
    state.effectState === "completed" ||
    mission.operations?.runs.some(
      (run) =>
        run.executionState === "unknown" ||
        (run.taskId === taskId &&
          (run.executionState === "running" ||
            !Number.isFinite(Date.parse(run.startedAt)) ||
            !Number.isFinite(Date.parse(run.finishedAt ?? "")))),
    )
  )
    return
  const decision = repairDecision(mission, taskId, taskRuns)
  if (taskRuns.some((run) => unreviewed(run, decision))) return
  const scope = createHash("sha256")
    .update(
      JSON.stringify({
        taskId,
        repairRound: state.repairRound ?? 0,
        ...(decision ? { chief: [decision.round, decision.at, decision.action, decision.taskId ?? null] } : {}),
      }),
    )
    .digest("hex")
  const prefix = `Bounded routing probe ${scope}: `
  const used = new Set(taskRuns.filter((run) => run.routingReason?.startsWith(prefix)).map(routeKey))
  const available = candidates.filter((candidate) => {
    if (used.has(routeKey(candidate))) return false
    if (!failed.has(routeKey(candidate))) return true
    const failure = taskRuns.findLast(
      (run) => routeKey(run) === routeKey(candidate) && (run.outcome === "failed" || run.outcome === "rejected"),
    )
    return (
      decision !== undefined &&
      failure !== undefined &&
      Number.isFinite(Date.parse(failure.finishedAt ?? "")) &&
      Date.parse(failure.finishedAt ?? "") < Date.parse(decision.at)
    )
  })
  const observed = (candidate: RoutingCandidate) => evidence.find((entry) => routeKey(entry) === routeKey(candidate))
  const successRate = (candidate: RoutingCandidate) => {
    const record = observed(candidate)
    return record?.samples ? record.successes / record.samples : -1
  }
  const cost = (candidate: RoutingCandidate) =>
    observed(candidate)?.successfulDeliverableCostUsd ?? Number.POSITIVE_INFINITY
  const candidate = available.sort((a, b) => successRate(b) - successRate(a) || cost(a) - cost(b)).at(0)
  if (!candidate) return
  return {
    candidate,
    reason:
      `${prefix}No fresh route met the measured quality preference. Selected ${candidate.actorType}/${candidate.model ?? "native default"} from the saved ready, compatible pool for one probe at this checkpoint; ` +
      "below-threshold evidence, task failures and spent execution limits remain unchanged.",
  }
}
