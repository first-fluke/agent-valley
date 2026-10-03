import {
  collectBusinessMetricSources,
  evaluateMetricObservation,
  type MetricCollectionDependencies,
  type MetricSourceCollection,
} from "@agent-valley/core/chief/metric-sources"
import {
  boundOrganizationContext,
  compareBusinessMetrics,
  listBusinessMetrics,
  loadOrganizationContext,
  type OrganizationContext,
} from "@agent-valley/core/chief/organization"
import type { Mission } from "@agent-valley/core/chief/types"

type MetricMission = Mission & { metricBaselineIds?: Record<string, string> }
function retainMetricEvidence(context: OrganizationContext, mission: MetricMission): OrganizationContext {
  if (mission.operatingPolicy?.memory === false) {
    context.memories = []
    context.outcomes = []
    context.experiments = []
    context.routeEvidence = []
  }
  return context
}
/** Keep exact mission baseline/current evidence in Chief context without expanding the prompt budget. */
async function organizationContext(
  repository: string,
  mission: MetricMission,
  now: number,
): Promise<OrganizationContext> {
  const targets = mission.operatingPolicy?.metricTargets ?? []
  const context = retainMetricEvidence(await loadOrganizationContext(repository, mission.goal, targets), mission)
  if (!mission.metricSourcePolicy || !mission.observationStartedAt || !targets.length) return context
  const observed = evaluateMetricObservation(
    mission.metricSourcePolicy,
    targets,
    await listBusinessMetrics(repository),
    mission.observationStartedAt,
    undefined,
    now,
    mission.metricBaselineIds,
  )
  const names = new Set(targets.map((target) => target.name))
  context.metrics = [
    ...context.metrics.filter((sample) => !names.has(sample.name)),
    ...observed.assessments.flatMap((assessment) =>
      [assessment.baseline, assessment.current].filter((sample) => sample !== undefined),
    ),
  ].slice(-40)
  context.omittedMetricNames = (context.omittedMetricNames ?? []).filter((name) => !names.has(name))
  context.comparisons = compareBusinessMetrics(context.metrics, targets).map(
    ({ baseline: _baseline, current: _current, ...comparison }) => comparison,
  )
  return boundOrganizationContext(context, targets)
}
export function createMissionMetricPorts(
  repository: string,
  mission: MetricMission,
  dependencies: MetricCollectionDependencies = {},
) {
  const clock = dependencies.now ?? Date.now
  return {
    async initialize(): Promise<void> {
      if (!mission.metricSourcePolicy || mission.metricBaselineIds !== undefined) return
      const collection = await collectBusinessMetricSources(repository, mission.metricSourcePolicy, dependencies)
      mission.metricBaselineIds = Object.fromEntries(
        collection.results.flatMap((result) => (result.sample ? [[result.sourceId, result.sample.id]] : [])),
      )
      const failed = collection.results.filter((result) => !result.sample)
      if (failed.length)
        mission.history.push({
          at: new Date(clock()).toISOString(),
          stage: "metric-source",
          message: failed
            .map((result) => `${result.sourceId}: ${result.reason ?? "No measured baseline is available."}`)
            .join("\n")
            .slice(0, 4_000),
        })
      mission.organizationContext = await organizationContext(repository, mission, clock())
    },
    async refreshOrganization(current: Mission): Promise<OrganizationContext> {
      if (current.metricSourcePolicy)
        await collectBusinessMetricSources(repository, current.metricSourcePolicy, dependencies)
      return organizationContext(repository, current, clock())
    },
    async observeMetrics(
      current: Mission,
    ): Promise<{ status: "satisfied" | "waiting" | "failed"; reason: string; nextPollAt?: string }> {
      if (!current.metricSourcePolicy)
        return { status: "satisfied", reason: "No automatic metric observation policy is configured." }
      if (!current.observationStartedAt)
        return {
          status: "failed",
          reason:
            "Metric observation requires its saved start timestamp after deliverable verification. Restore observationStartedAt before resuming.",
        }
      if (!current.operatingPolicy?.metricTargets?.length)
        return {
          status: "failed",
          reason: "Set chief.metric_targets in av.yaml before starting an order with automatic metric sources.",
        }
      try {
        const collection: MetricSourceCollection = await collectBusinessMetricSources(
          repository,
          current.metricSourcePolicy,
          dependencies,
        )
        const samples = await listBusinessMetrics(repository)
        const result = evaluateMetricObservation(
          current.metricSourcePolicy,
          current.operatingPolicy.metricTargets,
          samples,
          current.observationStartedAt,
          collection,
          clock(),
          (current as MetricMission).metricBaselineIds,
        )
        current.organizationContext = await organizationContext(repository, current, clock())
        return {
          status: result.status,
          reason: result.assessments
            .map((assessment) => `${assessment.name}: ${assessment.reason}`)
            .join("\n")
            .slice(0, 16_000),
          nextPollAt: result.nextPollAt,
        }
      } catch {
        const now = clock()
        const deadline = Date.parse(current.observationStartedAt) + current.metricSourcePolicy.max_observation_ms
        return {
          status: now >= deadline ? "failed" : "waiting",
          reason:
            "Business metric evidence could not be collected or restored. Check source access, credentials, JSON format and repository metric storage; unavailable data never satisfies the goal.",
          nextPollAt: new Date(
            Math.min(
              now + Math.min(...current.metricSourcePolicy.sources.map((source) => source.poll_interval_ms)),
              deadline,
            ),
          ).toISOString(),
        }
      }
    },
  }
}
