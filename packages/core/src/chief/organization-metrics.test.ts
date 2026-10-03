import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  assessMetricTargets,
  type BusinessMetricSample,
  compareBusinessMetrics,
  importBusinessMetrics,
  listBusinessExperiments,
  listBusinessMetrics,
  loadOrganizationContext,
  type MetricTarget,
  metricTargetCriterion,
  recordBusinessExperiment,
  recordBusinessMetric,
} from "./organization"

let root: string
let source: string
const observation = (overrides: Record<string, unknown> = {}) => ({
  name: "signup-conversion",
  value: 0.1,
  unit: "fraction",
  source: "Operator analytics export: signup-funnel.csv",
  timestamp: "2026-01-01T00:00:00Z",
  ...overrides,
})
const sample = (overrides: Partial<BusinessMetricSample> = {}): BusinessMetricSample =>
  ({
    id: "before",
    ...observation(),
    provenance: "operator-recorded",
    ...overrides,
  }) as BusinessMetricSample
const target: MetricTarget = { name: "signup-conversion", unit: "fraction", direction: "increase", target: 0.2 }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "av-business-metrics-"))
  source = join(root, "source")
  await mkdir(source)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("actual manually recorded business observations", () => {
  it("preserves provenance, source, unit and timestamp and imports idempotently", async () => {
    const json = JSON.stringify([observation(), observation({ value: 0.25, timestamp: "2026-02-01T00:00:00Z" })])
    await importBusinessMetrics(source, json)
    await importBusinessMetrics(source, json)
    const records = await listBusinessMetrics(source)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      name: "signup-conversion",
      value: 0.1,
      unit: "fraction",
      source: "Operator analytics export: signup-funnel.csv",
      provenance: "operator-recorded",
      timestamp: "2026-01-01T00:00:00Z",
    })
  })

  it.each([
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    { source: "" },
    { unit: "" },
    { timestamp: "not-a-date" },
    { timestamp: "2099-01-01T00:00:00Z" },
    { provenance: "independently-verified" },
  ])("rejects invented or unqualified measurement fields %j", async (invalid) => {
    await expect(recordBusinessMetric(source, observation(invalid))).rejects.toThrow()
    expect(await listBusinessMetrics(source)).toEqual([])
  })

  it("validates the complete import before saving and rejects oversized or invalid JSON", async () => {
    await expect(
      importBusinessMetrics(source, JSON.stringify([observation(), observation({ unit: "" })])),
    ).rejects.toThrow()
    expect(await listBusinessMetrics(source)).toEqual([])
    await expect(importBusinessMetrics(source, "broken JSON")).rejects.toThrow()
    await expect(importBusinessMetrics(source, "x".repeat(2_000_001))).rejects.toThrow("exceeds 2 MB")
  })

  it("rejects a changed observation with a reused ID", async () => {
    await recordBusinessMetric(source, observation({ id: "immutable-sample" }))
    await expect(recordBusinessMetric(source, observation({ id: "immutable-sample", value: 100 }))).rejects.toThrow(
      "different evidence",
    )
    expect((await listBusinessMetrics(source))[0]?.value).toBe(0.1)
  })
})

describe("honest baseline, current, target comparisons", () => {
  it("shows measured improvement separately from attaining the fixed target", () => {
    const comparison = compareBusinessMetrics(
      [sample(), sample({ id: "after", value: 0.15, timestamp: "2026-02-01T00:00:00Z" })],
      [target],
    )[0]
    expect(comparison).toMatchObject({
      status: "improved",
      targetMet: false,
      baseline: { value: 0.1 },
      current: { value: 0.15 },
    })
    expect(comparison?.delta).toBeCloseTo(0.05)
    expect(comparison?.reason).toContain("does not establish causation")
  })

  it.each([
    ["increase", 0.3, "improved"],
    ["increase", 0.05, "regressed"],
    ["decrease", 0.05, "improved"],
    ["decrease", 0.3, "regressed"],
    ["increase", 0.1, "unchanged"],
  ] as const)("compares %s direction and value %s without favorable-result bias", (direction, value, expected) => {
    const comparisons = compareBusinessMetrics(
      [sample(), sample({ id: "after", value, timestamp: "2026-02-01T00:00:00Z" })],
      [{ ...target, direction }],
    )
    expect(comparisons[0]?.status).toBe(expected)
  })

  it("marks missing observations, indistinguishable timestamps and unit changes honestly", () => {
    expect(compareBusinessMetrics([], [target])[0]?.status).toBe("missing-evidence")
    expect(compareBusinessMetrics([sample()], [target])[0]?.status).toBe("missing-evidence")
    expect(compareBusinessMetrics([sample(), sample({ id: "after", value: 0.3 })], [target])[0]?.status).toBe(
      "missing-evidence",
    )
    expect(
      compareBusinessMetrics(
        [sample(), sample({ id: "after", unit: "percent", value: 30, timestamp: "2026-02-01T00:00:00Z" })],
        [target],
      )[0]?.status,
    ).toBe("unit-mismatch")
  })

  it("evaluates a numeric threshold from a source-qualified latest observation independently of LLM claims", async () => {
    await recordBusinessMetric(source, observation({ value: 0.15 }))
    let context = await loadOrganizationContext(source, "Improve signup conversion", [target])
    expect(assessMetricTargets(context, [target])[0]?.passed).toBe(false)
    await recordBusinessMetric(source, observation({ value: 0.25, timestamp: "2026-02-01T00:00:00Z" }))
    context = await loadOrganizationContext(source, "Improve signup conversion", [target])
    const assessment = assessMetricTargets(context, [target])[0]
    expect(assessment?.passed).toBe(true)
    expect(assessment?.evidence).toContain("Operator analytics export")
    expect(assessment?.evidence).toContain("not independently verified")
    expect(metricTargetCriterion(target)).toBe("metric:signup-conversion:increase:0.2")
    expect(assessMetricTargets(undefined, [target])[0]?.passed).toBe(false)
  })

  it("does not pass targets with an unknown source or mismatched units", async () => {
    await recordBusinessMetric(source, observation({ value: 100, source: "unknown" }))
    const context = await loadOrganizationContext(source, "Signup", [target])
    expect(assessMetricTargets(context, [target])[0]?.passed).toBe(false)
    expect(assessMetricTargets(context, [{ ...target, unit: "USD" }])[0]?.passed).toBe(false)
  })

  it("requires real before/after improvement when no numeric target was set", async () => {
    const improvement: MetricTarget = { name: target.name, direction: "increase" }
    await recordBusinessMetric(source, observation())
    expect(
      assessMetricTargets(await loadOrganizationContext(source, "Signup", [improvement]), [improvement])[0]?.passed,
    ).toBe(false)
    await recordBusinessMetric(source, observation({ value: 0.15, timestamp: "2026-02-01T00:00:00Z" }))
    expect(
      assessMetricTargets(await loadOrganizationContext(source, "Signup", [improvement]), [improvement])[0]?.passed,
    ).toBe(true)
  })

  it("retains every targeted baseline/current sample before other historical prompt context", async () => {
    const targets = Array.from(
      { length: 20 },
      (_, index): MetricTarget => ({ name: `metric-${index}`, direction: "increase", target: 3, unit: "count" }),
    )
    await Promise.all(
      targets.flatMap((item) => [
        recordBusinessMetric(source, observation({ name: item.name, unit: "count", value: 1 })),
        recordBusinessMetric(
          source,
          observation({ name: item.name, unit: "count", value: 3, timestamp: "2026-02-01T00:00:00Z" }),
        ),
      ]),
    )
    const context = await loadOrganizationContext(source, "Growth", targets)
    for (const item of targets) {
      if (context.omittedMetricNames?.includes(item.name))
        expect(assessMetricTargets(context, [item])[0]?.passed).toBe(false)
      else expect(context.metrics.filter((entry) => entry.name === item.name)).toHaveLength(2)
    }
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(16_000)
  })

  it("explicitly identifies target observations omitted under the evidence budget", async () => {
    const targets = Array.from(
      { length: 20 },
      (_, index): MetricTarget => ({ name: `metric-${index}`, direction: "increase", target: 3, unit: "count" }),
    )
    await Promise.all(
      targets.flatMap((item) => [
        recordBusinessMetric(
          source,
          observation({ name: item.name, unit: "count", value: 1, source: "s".repeat(500) }),
        ),
        recordBusinessMetric(
          source,
          observation({
            name: item.name,
            unit: "count",
            value: 3,
            source: "s".repeat(500),
            timestamp: "2026-02-01T00:00:00Z",
          }),
        ),
      ]),
    )
    const context = await loadOrganizationContext(source, "Growth", targets)
    expect(context.omittedMetricNames?.length).toBeGreaterThan(0)
    for (const name of context.omittedMetricNames ?? [])
      expect(
        assessMetricTargets(
          context,
          targets.filter((item) => item.name === name),
        )[0],
      ).toMatchObject({ passed: false, evidence: expect.stringContaining("omitted") })
  })
})

describe("tracked business experiments", () => {
  it("links recorded before/after observations and explicitly attributes adjudication to the operator", async () => {
    const before = await recordBusinessMetric(source, observation({ id: "baseline" }))
    const after = await recordBusinessMetric(
      source,
      observation({ id: "current", value: 0.25, timestamp: "2026-02-01T00:00:00Z" }),
    )
    const input = {
      id: "signup-test",
      name: "Signup short path",
      hypothesis: "Fewer screens may improve conversion",
      targets: [target],
      beforeSampleIds: [before.id],
      afterSampleIds: [after.id],
      timestamp: "2026-02-02T00:00:00Z",
      adjudication: {
        status: "supported",
        reason: "Operator reviewed the actual export",
        source: "Operator review",
        timestamp: "2026-02-02T00:00:00Z",
      },
    }
    const experiment = await recordBusinessExperiment(source, input)
    await recordBusinessExperiment(source, input)
    expect(experiment.provenance).toBe("operator-recorded")
    expect(experiment.comparisons[0]).toMatchObject({ status: "improved", targetMet: true })
    expect(await listBusinessExperiments(source)).toHaveLength(1)
    expect((await loadOrganizationContext(source, "Improve signup conversion", [target])).experiments[0]?.id).toBe(
      "signup-test",
    )
  })

  it("rejects fabricated experiment references and premature adjudication", async () => {
    const input = {
      id: "test",
      name: "Signup",
      hypothesis: "A hypothesis",
      targets: [target],
      beforeSampleIds: ["missing"],
      afterSampleIds: [],
      timestamp: "2026-02-02T00:00:00Z",
    }
    await expect(recordBusinessExperiment(source, input)).rejects.toThrow("sample missing is missing")
    await expect(
      recordBusinessExperiment(source, {
        ...input,
        beforeSampleIds: [],
        adjudication: { status: "supported", reason: "Guess", source: "Operator", timestamp: input.timestamp },
      }),
    ).rejects.toThrow("comparable recorded")
  })

  it("does not convert a hypothesis into success and validates before/after chronology", async () => {
    await recordBusinessMetric(source, observation({ id: "sample" }))
    const input = {
      id: "test",
      name: "Signup",
      hypothesis: "May improve conversion",
      targets: [target],
      beforeSampleIds: ["sample"],
      afterSampleIds: [],
      timestamp: "2026-02-02T00:00:00Z",
    }
    const proposed = await recordBusinessExperiment(source, input)
    expect(proposed.adjudication).toBeUndefined()
    expect(proposed.comparisons[0]?.status).toBe("missing-evidence")
    await expect(recordBusinessExperiment(source, { ...input, afterSampleIds: ["sample"] })).rejects.toThrow(
      "must be distinct",
    )
    await recordBusinessMetric(source, observation({ id: "earlier", timestamp: "2025-12-01T00:00:00Z" }))
    await expect(recordBusinessExperiment(source, { ...input, afterSampleIds: ["earlier"] })).rejects.toThrow(
      "must be later",
    )
  })
})
