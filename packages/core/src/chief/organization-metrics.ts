import { appendOrganizationRecord, organizationRecordKey, readOrganizationRecords } from "./organization-store"
import {
  type BusinessExperiment,
  type BusinessMetricSample,
  businessExperimentInputSchema,
  businessExperimentSchema,
  businessMetricInputSchema,
  businessMetricSampleSchema,
  collectedBusinessMetricInputSchema,
  type MetricComparison,
  type MetricTarget,
  metricTargetSchema,
} from "./organization-types"

export async function listBusinessMetrics(sourceRepo: string): Promise<BusinessMetricSample[]> {
  return (await readOrganizationRecords(sourceRepo, "metrics", businessMetricSampleSchema)).sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id),
  )
}
export async function recordBusinessMetric(sourceRepo: string, input: unknown): Promise<BusinessMetricSample> {
  const parsed = businessMetricInputSchema.parse(input)
  if (Date.parse(parsed.timestamp) > Date.now())
    throw new Error("Metric observations cannot have a future timestamp. Record actual measured data.")
  const sample = businessMetricSampleSchema.parse({
    ...parsed,
    id: parsed.id ?? organizationRecordKey(parsed),
    provenance: "operator-recorded",
  })
  return appendOrganizationRecord(sourceRepo, "metrics", sample.id, sample, businessMetricSampleSchema)
}
/** Read-only source observations remain source-attributed; fetching does not prove causal impact. */
export async function recordCollectedBusinessMetric(
  sourceRepo: string,
  input: unknown,
  now = Date.now(),
): Promise<BusinessMetricSample> {
  const parsed = collectedBusinessMetricInputSchema.parse(input)
  if (
    Date.parse(parsed.timestamp) > now ||
    Date.parse(parsed.collectedAt) > now ||
    (parsed.window && Date.parse(parsed.window.end) > now)
  )
    throw new Error("Collected metric observations cannot have a future timestamp or window.")
  const id = organizationRecordKey({
    sourceId: parsed.sourceId,
    name: parsed.name,
    timestamp: parsed.timestamp,
    window: parsed.window,
  })
  const sample = businessMetricSampleSchema.parse({ ...parsed, id, provenance: "source-collected" })
  const stored = await appendOrganizationRecord(
    sourceRepo,
    "metrics",
    sample.id,
    sample,
    businessMetricSampleSchema,
    true,
  )
  const { collectedAt: _storedAt, ...storedEvidence } = stored
  const { collectedAt: _sampleAt, ...sampleEvidence } = sample
  if (JSON.stringify(storedEvidence) !== JSON.stringify(sampleEvidence))
    throw new Error("The metric source changed evidence at an existing measurement timestamp. Publish a new timestamp.")
  return stored
}
export function compareBusinessMetrics(samples: BusinessMetricSample[], targets: MetricTarget[]): MetricComparison[] {
  const checked = businessMetricSampleSchema.array().max(10_000).parse(samples)
  return metricTargetSchema
    .array()
    .max(20)
    .parse(targets)
    .map((target) => {
      const candidates = checked
        .filter((sample) => sample.name === target.name)
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id))
      const baseline = candidates[0]
      const current = candidates[candidates.length - 1]
      const base = { ...target, baseline, current }
      if (
        new Set(candidates.map((sample) => sample.unit)).size > 1 ||
        candidates.some((sample) => target.unit !== undefined && sample.unit !== target.unit)
      )
        return {
          ...base,
          status: "unit-mismatch",
          reason: "Recorded units differ. Use comparable samples before drawing a result.",
        }
      if (
        !baseline ||
        !current ||
        baseline.id === current.id ||
        Date.parse(baseline.timestamp) >= Date.parse(current.timestamp)
      )
        return {
          ...base,
          unit: target.unit ?? current?.unit,
          status: "missing-evidence",
          reason: "Record distinct before and after samples with source, unit, and timestamp.",
        }
      const delta = current.value - baseline.value
      if (!Number.isFinite(delta))
        return {
          ...base,
          status: "missing-evidence",
          reason: "The recorded difference exceeds a finite numeric range.",
        }
      const favorable = target.direction === "increase" ? delta > 0 : delta < 0
      const status = delta === 0 ? "unchanged" : favorable ? "improved" : "regressed"
      const targetMet =
        target.target === undefined
          ? undefined
          : target.direction === "increase"
            ? current.value >= target.target
            : current.value <= target.target
      return {
        ...base,
        unit: target.unit ?? current.unit,
        status,
        delta,
        targetMet,
        reason:
          "Comparison of source-attributed observations; this alone does not establish causation or audit the external source.",
      }
    })
}
export async function listBusinessExperiments(sourceRepo: string): Promise<BusinessExperiment[]> {
  const records = await readOrganizationRecords(sourceRepo, "experiments", businessExperimentSchema)
  const latest = new Map<string, BusinessExperiment>()
  for (const record of records.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)))
    latest.set(record.id, record)
  return [...latest.values()].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
}
export async function recordBusinessExperiment(sourceRepo: string, input: unknown): Promise<BusinessExperiment> {
  const parsed = businessExperimentInputSchema.parse(input)
  const samples = await listBusinessMetrics(sourceRepo)
  const ids = [...parsed.beforeSampleIds, ...parsed.afterSampleIds]
  const selected = ids.map((id) => {
    const sample = samples.find((candidate) => candidate.id === id)
    if (!sample) throw new Error(`Experiment sample ${id} is missing. Record the observation before linking it.`)
    if (!parsed.targets.some((target) => target.name === sample.name))
      throw new Error("Experiment samples must match a named metric target.")
    return sample
  })
  if (new Set(ids).size !== ids.length) throw new Error("Experiment before and after sample IDs must be distinct.")
  const before = selected.slice(0, parsed.beforeSampleIds.length)
  const after = selected.slice(parsed.beforeSampleIds.length)
  if (
    before.length &&
    after.length &&
    Math.max(...before.map((sample) => Date.parse(sample.timestamp))) >=
      Math.min(...after.map((sample) => Date.parse(sample.timestamp)))
  )
    throw new Error("Experiment after observations must be later than before observations.")
  const comparisons = compareBusinessMetrics(selected, parsed.targets)
  if (
    parsed.adjudication &&
    (!before.length ||
      !after.length ||
      comparisons.some((item) => ["missing-evidence", "unit-mismatch"].includes(item.status)))
  )
    throw new Error("Experiment adjudication requires comparable recorded before and after evidence for every target.")
  const experiment = businessExperimentSchema.parse({ ...parsed, provenance: "operator-recorded", comparisons })
  return appendOrganizationRecord(
    sourceRepo,
    "experiments",
    [experiment.id, organizationRecordKey(experiment)],
    experiment,
    businessExperimentSchema,
  )
}
/** Deterministic manual-import adapter. It never fetches analytics or treats imported data as independently verified. */
export async function importBusinessMetrics(sourceRepo: string, json: string): Promise<BusinessMetricSample[]> {
  if (Buffer.byteLength(json) > 2_000_000) throw new Error("Metric import exceeds 2 MB. Split it into smaller files.")
  const inputs = businessMetricInputSchema.array().max(10_000).parse(JSON.parse(json))
  return Promise.all(inputs.map((input) => recordBusinessMetric(sourceRepo, input)))
}
