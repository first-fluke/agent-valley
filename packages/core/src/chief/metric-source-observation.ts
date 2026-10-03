import { z } from "zod"
import { type MetricSourceCollection, type MetricSourcePolicy, metricSourcePolicySchema } from "./metric-source-policy"
import {
  type BusinessMetricSample,
  businessMetricSampleSchema,
  type MetricTarget,
  metricTargetSchema,
  organizationTimestampSchema,
} from "./organization-types"

export const metricObservationStateSchema = z.strictObject({
  status: z.enum(["satisfied", "waiting", "failed"]),
  startedAt: organizationTimestampSchema,
  deadline: organizationTimestampSchema,
  nextPollAt: organizationTimestampSchema,
  assessments: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(120),
        sourceId: z.string().min(1).max(120).optional(),
        passed: z.boolean(),
        baseline: businessMetricSampleSchema.optional(),
        current: businessMetricSampleSchema.optional(),
        reason: z.string().min(1).max(1_000),
      }),
    )
    .max(20),
})
export type MetricObservationState = z.output<typeof metricObservationStateSchema>
/** Fixed targets require fresh source-collected evidence measured after this mission's observation began.
 * Historical successes and operator imports cannot complete a new automatic observation period.
 */
export function evaluateMetricObservation(
  policyInput: MetricSourcePolicy,
  targetsInput: MetricTarget[],
  samplesInput: BusinessMetricSample[],
  startedAt: string,
  collection?: MetricSourceCollection,
  now = Date.now(),
  baselineSampleIds?: Readonly<Record<string, string>>,
): MetricObservationState {
  const policy = metricSourcePolicySchema.parse(policyInput)
  const targets = metricTargetSchema.array().max(20).parse(targetsInput)
  const samples = businessMetricSampleSchema.array().max(10_000).parse(samplesInput)
  const started = Date.parse(organizationTimestampSchema.parse(startedAt))
  if (started > now)
    throw new Error(
      "Metric observation cannot start in the future. Restore the mission's actual observation timestamp.",
    )
  const deadline = started + policy.max_observation_ms
  const earliest = started + policy.observation_window_ms
  let invalidConfiguration = false
  const assessments: MetricObservationState["assessments"] = targets.map((target) => {
    const source = policy.sources.find((candidate) => candidate.name === target.name)
    if (!source || (target.unit !== undefined && target.unit !== source.unit)) {
      invalidConfiguration = true
      return {
        name: target.name,
        passed: false,
        reason:
          "Configure an authoritative metric source with the target's unit in chief.metric_sources.sources; missing or mismatched sources cannot satisfy this goal.",
      }
    }
    const candidates = samples
      .filter(
        (sample) =>
          sample.name === target.name &&
          sample.sourceId === source.id &&
          sample.provenance === "source-collected" &&
          sample.unit === source.unit &&
          sample.collectedAt &&
          Date.parse(sample.timestamp) <= Math.min(now, deadline) &&
          Date.parse(sample.collectedAt) <= now,
      )
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
    const baseline = candidates
      .filter(
        (sample) =>
          Date.parse(sample.timestamp) <= started &&
          Date.parse(sample.collectedAt as string) <= started &&
          (baselineSampleIds
            ? sample.id === baselineSampleIds[source.id] &&
              Date.parse(sample.collectedAt as string) - Date.parse(sample.timestamp) <= source.max_age_ms
            : started - Date.parse(sample.timestamp) <= source.max_age_ms),
      )
      .at(-1)
    const current = candidates
      .filter((sample) => {
        const measured = Date.parse(sample.timestamp)
        return (
          measured > started &&
          measured >= earliest &&
          now - measured <= source.max_age_ms &&
          Date.parse(sample.collectedAt as string) >= started &&
          (!sample.window ||
            (Date.parse(sample.window.start) >= started &&
              Date.parse(sample.window.end) >= earliest &&
              now - Date.parse(sample.window.end) <= source.max_age_ms))
        )
      })
      .at(-1)
    const base = { name: target.name, sourceId: source.id, baseline, current }
    const result = collection?.results.find((item) => item.sourceId === source.id)
    if (result && !["collected", "unchanged"].includes(result.status))
      return {
        ...base,
        passed: false,
        reason:
          result.reason ?? "Current source collection did not produce usable evidence. Wait for a valid observation.",
      }
    if (!current || now < earliest)
      return {
        ...base,
        passed: false,
        reason:
          "Waiting for a fresh source observation measured after this mission began and covering the required observation window.",
      }
    if (target.target !== undefined) {
      const passed = target.direction === "increase" ? current.value >= target.target : current.value <= target.target
      return {
        ...base,
        passed,
        reason: `Measured ${current.value} ${current.unit}; fixed target ${target.direction} ${target.target}. Source attribution does not establish causal impact.`,
      }
    }
    if (!baseline || baseline.id === current.id)
      return {
        ...base,
        passed: false,
        reason:
          "No fresh source-collected baseline exists before the observation started. Collect a baseline before beginning the next experiment.",
      }
    if (
      !!baseline.window !== !!current.window ||
      (baseline.window &&
        current.window &&
        Date.parse(baseline.window.end) - Date.parse(baseline.window.start) !==
          Date.parse(current.window.end) - Date.parse(current.window.start))
    )
      return {
        ...base,
        passed: false,
        reason: "Baseline and current measurement windows differ in duration. Compare equivalent measurement windows.",
      }
    const delta = current.value - baseline.value
    const passed = Number.isFinite(delta) && (target.direction === "increase" ? delta > 0 : delta < 0)
    return {
      ...base,
      passed,
      reason: `Measured before=${baseline.value}, after=${current.value} ${current.unit}; source=${source.id}. This comparison does not establish causal impact.`,
    }
  })
  const passed = targets.length > 0 && assessments.every((assessment) => assessment.passed)
  const windowMeasured =
    targets.length > 0 &&
    assessments.every((assessment) => {
      const fetched = collection?.results.find((result) => result.sourceId === assessment.sourceId)
      return !!assessment.current && (!fetched || ["collected", "unchanged"].includes(fetched.status))
    })
  const next = collection
    ? Date.parse(collection.nextPollAt)
    : now + Math.min(...policy.sources.map((source) => source.poll_interval_ms))
  return metricObservationStateSchema.parse({
    status: passed ? "satisfied" : invalidConfiguration || windowMeasured || now >= deadline ? "failed" : "waiting",
    startedAt,
    deadline: new Date(deadline).toISOString(),
    nextPollAt: new Date(Math.min(Math.max(now + 1, next), deadline)).toISOString(),
    assessments,
  })
}
