import { httpJsonMetricAdapter, jsonFileMetricAdapter } from "./metric-source-adapters"
import {
  type MetricSource,
  type MetricSourceAdapter,
  type MetricSourceCollection,
  MetricSourceError,
  type MetricSourcePolicy,
  type MetricSourceRegistry,
  metricSourceCollectionSchema,
  metricSourcePolicySchema,
  type SourceMetricObservation,
  sourceMetricObservationSchema,
} from "./metric-source-policy"
import { stripeRevenueMetricAdapter } from "./metric-source-stripe"
import { loadOrganizationContext } from "./organization"
import { listBusinessMetrics, recordCollectedBusinessMetric } from "./organization-metrics"
import type { BusinessMetricSample, MetricTarget, OrganizationContext } from "./organization-types"

export * from "./metric-source-observation"
export * from "./metric-source-policy"
export interface MetricCollectionDependencies {
  fetch?: typeof globalThis.fetch
  env?: Readonly<Record<string, string | undefined>>
  registry?: MetricSourceRegistry
  now?: () => number
  signal?: AbortSignal
}
export function createMetricSourceRegistry(additional?: MetricSourceRegistry): MetricSourceRegistry {
  return new Map<string, MetricSourceAdapter>([
    ["http-json", httpJsonMetricAdapter],
    ["json-file", jsonFileMetricAdapter],
    ["stripe-revenue", stripeRevenueMetricAdapter],
    ...(additional ?? []),
  ])
}
function validateObservation(
  input: SourceMetricObservation,
  source: MetricSource,
  now: number,
): SourceMetricObservation {
  const parsed = sourceMetricObservationSchema.safeParse(input)
  if (!parsed.success)
    throw new MetricSourceError(
      "Metric adapter returned incomplete or nonfinite evidence. Correct the source adapter before resuming.",
    )
  const sample = parsed.data
  if (sample.unit !== source.unit)
    throw new MetricSourceError(
      "Metric source units differ from the configured unit. Correct the source or unit; incompatible observations cannot satisfy the goal.",
    )
  const timestamp = Date.parse(sample.timestamp)
  if (
    timestamp > now ||
    (sample.window && (Date.parse(sample.window.end) > timestamp || Date.parse(sample.window.end) > now))
  )
    throw new MetricSourceError(
      "Metric source timestamp or measurement window is in the future. Publish actual measured data.",
    )
  if (now - timestamp > source.max_age_ms || (sample.window && now - Date.parse(sample.window.end) > source.max_age_ms))
    throw new MetricSourceError(
      "Metric source observation is stale. Refresh the analytics source; stale data cannot satisfy the goal.",
      true,
    )
  return sample
}
function collectionFailure(error: unknown): { status: "unavailable" | "failed"; reason: string } {
  if (error instanceof MetricSourceError)
    return { status: error.unavailable ? "unavailable" : "failed", reason: error.message }
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
    return {
      status: "unavailable",
      reason: "Metric JSON file is unavailable. Restore the configured repository-relative source export and resume.",
    }
  if (
    (error as Error)?.message ===
    "The metric source changed evidence at an existing measurement timestamp. Publish a new timestamp."
  )
    return {
      status: "failed",
      reason:
        "Metric source changed evidence at a previously recorded timestamp. Publish a new observation timestamp; existing evidence remains immutable.",
    }
  return {
    status: "unavailable",
    reason:
      "Metric collection was interrupted or could not read the source. Check connectivity, source access and JSON format, then resume.",
  }
}
export async function collectBusinessMetricSources(
  repositoryRoot: string,
  policyInput: MetricSourcePolicy,
  dependencies: MetricCollectionDependencies = {},
): Promise<MetricSourceCollection> {
  const policy = metricSourcePolicySchema.parse(policyInput)
  const clock = dependencies.now ?? Date.now
  const registry = createMetricSourceRegistry(dependencies.registry)
  const existing = await listBusinessMetrics(repositoryRoot)
  const results: MetricSourceCollection["results"] = []
  // Sequential bounded reads keep provider rate limits and source memory usage predictable.
  for (const source of policy.sources) {
    const adapter = registry.get(source.adapter)
    if (!adapter) {
      results.push({
        sourceId: source.id,
        name: source.name,
        status: "unavailable",
        reason:
          "Metric adapter is unavailable. Register the configured adapter or choose http-json, json-file or stripe-revenue in av.yaml.",
      })
      continue
    }
    const controller = new AbortController()
    const abort = () => controller.abort(dependencies.signal?.reason)
    dependencies.signal?.addEventListener("abort", abort, { once: true })
    if (dependencies.signal?.aborted) abort()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (controller.signal.aborted)
        throw new MetricSourceError("Metric collection was interrupted. Resume when the mission can continue.", true)
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new MetricSourceError(
              "Metric collection timed out. Check source availability and timeout_ms, then resume.",
              true,
            ),
          )
          controller.abort()
        }, source.timeout_ms)
      })
      const interrupted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () =>
            reject(
              new MetricSourceError("Metric collection was interrupted. Resume when the mission can continue.", true),
            ),
          { once: true },
        )
      })
      const received = await Promise.race([
        adapter.collect({
          source,
          repositoryRoot,
          now: clock(),
          signal: controller.signal,
          fetch: dependencies.fetch ?? globalThis.fetch,
          env: dependencies.env ?? process.env,
        }),
        timeout,
        interrupted,
      ])
      const observedNow = clock()
      const observation = validateObservation(received, source, observedNow)
      const sample = await recordCollectedBusinessMetric(
        repositoryRoot,
        {
          name: source.name,
          value: observation.value,
          unit: observation.unit,
          source: `metric-source:${source.id}:${source.adapter}`,
          sourceId: source.id,
          timestamp: observation.timestamp,
          collectedAt: new Date(observedNow).toISOString(),
          window: observation.window,
        },
        observedNow,
      )
      results.push({
        sourceId: source.id,
        name: source.name,
        status: existing.some((record) => record.id === sample.id) ? "unchanged" : "collected",
        sample,
      })
    } catch (error) {
      results.push({ sourceId: source.id, name: source.name, ...collectionFailure(error) })
    } finally {
      if (timer) clearTimeout(timer)
      dependencies.signal?.removeEventListener("abort", abort)
      controller.abort()
    }
  }
  const finishedAt = clock()
  return metricSourceCollectionSchema.parse({
    collectedAt: new Date(finishedAt).toISOString(),
    nextPollAt: new Date(
      finishedAt + Math.min(...policy.sources.map((source) => source.poll_interval_ms)),
    ).toISOString(),
    results,
  })
}
export async function refreshBusinessMetricSources(
  repositoryRoot: string,
  goal: string,
  policy: MetricSourcePolicy,
  targets: MetricTarget[] = [],
  dependencies: MetricCollectionDependencies = {},
): Promise<{ collection: MetricSourceCollection; context: OrganizationContext; samples: BusinessMetricSample[] }> {
  const collection = await collectBusinessMetricSources(repositoryRoot, policy, dependencies)
  const [context, samples] = await Promise.all([
    loadOrganizationContext(repositoryRoot, goal, targets),
    listBusinessMetrics(repositoryRoot),
  ])
  return { collection, context, samples }
}
