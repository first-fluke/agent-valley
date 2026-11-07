import { createHash } from "node:crypto"
import { DEFAULT_EVIDENCE_WINDOW, type OperatingRun, type RouteEvidence, type RoutingCandidate } from "./operations"
import { routePrice, routeSuccessRate } from "./route-quality"
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

/**
 * Extra dispatches — a bounded probe or a degraded fallback — need the same settled, reviewable
 * saved checkpoint. Uncertain effects, unfinished runs and unreviewed output keep their wait.
 */
function settledWorkCheckpoint(mission: Mission, taskId: string | undefined, taskRuns: OperatingRun[]) {
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
  return { taskId, state, decision }
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
  const checkpoint = settledWorkCheckpoint(mission, taskId, taskRuns)
  if (!checkpoint) return
  const { state, decision } = checkpoint
  const scope = createHash("sha256")
    .update(
      JSON.stringify({
        taskId: checkpoint.taskId,
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
  const window = mission.operatingPolicy?.routing?.evidenceWindow ?? DEFAULT_EVIDENCE_WINDOW
  const successRate = (candidate: RoutingCandidate) => routeSuccessRate(observed(candidate), window)
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

/**
 * Below-threshold evidence is not a mission failure. Once every probe is spent, keep working on the
 * best measured ready route that has not already failed this task; callers pass only those routes.
 */
export function degradedWorkRoute(
  mission: Mission,
  taskId: string | undefined,
  candidates: RoutingCandidate[],
  evidence: RouteEvidence[],
  taskRuns: OperatingRun[],
  window: number,
  routeKey: (route: { actorType: string; model?: string }) => string,
): { candidate: RoutingCandidate; reason: string } | undefined {
  if (!settledWorkCheckpoint(mission, taskId, taskRuns)) return
  const observed = (candidate: RoutingCandidate) => evidence.find((entry) => routeKey(entry) === routeKey(candidate))
  // A stable sort keeps the configured candidate order when rate and price both tie.
  const candidate = [...candidates]
    .sort(
      (a, b) =>
        routeSuccessRate(observed(b), window) - routeSuccessRate(observed(a), window) || routePrice(a) - routePrice(b),
    )
    .at(0)
  if (!candidate) return
  return {
    candidate,
    reason: "Degraded: every route is below min_success_rate; selected the best measured route.",
  }
}
