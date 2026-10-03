import { describe, expect, it } from "vitest"
import { evaluateMetricObservation, type MetricSourceCollection, metricSourcePolicySchema } from "./metric-sources"
import type { BusinessMetricSample, MetricTarget } from "./organization-types"

const startedAt = "2026-10-01T12:00:00Z"
const started = Date.parse(startedAt)
const policy = metricSourcePolicySchema.parse({
  sources: [
    {
      id: "signup-api",
      name: "signup-conversion",
      unit: "fraction",
      url_env: "ANALYTICS_URL",
      max_age_ms: 30_000,
      poll_interval_ms: 10_000,
    },
  ],
  observation_window_ms: 60_000,
  max_observation_ms: 120_000,
})
const target: MetricTarget = { name: "signup-conversion", unit: "fraction", direction: "increase", target: 0.2 }
const sample = (offset: number, overrides: Partial<BusinessMetricSample> = {}): BusinessMetricSample => ({
  id: `sample-${offset}`,
  name: "signup-conversion",
  unit: "fraction",
  source: "metric-source:signup-api:http-json",
  sourceId: "signup-api",
  provenance: "source-collected",
  collectedAt: new Date(started + offset).toISOString(),
  value: 0.25,
  timestamp: new Date(started + offset).toISOString(),
  ...overrides,
})
const collection = (offset: number, overrides: Partial<MetricSourceCollection> = {}): MetricSourceCollection => ({
  collectedAt: new Date(started + offset).toISOString(),
  nextPollAt: new Date(started + offset + 10_000).toISOString(),
  results: [{ sourceId: "signup-api", name: "signup-conversion", status: "collected", sample: sample(offset) }],
  ...overrides,
})

describe("goal observation period with actual source evidence", () => {
  it("waits for a new post-mission observation even if historic or imported metrics exceeded the target", () => {
    const records = [
      sample(-1_000),
      sample(70_000, { provenance: "operator-recorded", sourceId: undefined, collectedAt: undefined }),
    ]
    expect(evaluateMetricObservation(policy, [target], records, startedAt, undefined, started + 70_000).status).toBe(
      "waiting",
    )
  })

  it("never passes before the required observation window and accepts fresh measured results afterward", () => {
    expect(
      evaluateMetricObservation(policy, [target], [sample(10_000)], startedAt, collection(10_000), started + 10_000),
    ).toMatchObject({ status: "waiting", nextPollAt: new Date(started + 20_000).toISOString() })
    const result = evaluateMetricObservation(
      policy,
      [target],
      [sample(70_000)],
      startedAt,
      collection(70_000),
      started + 70_000,
    )
    expect(result.status).toBe("satisfied")
    expect(result.assessments[0]).toMatchObject({ passed: true, current: { value: 0.25, sourceId: "signup-api" } })
  })

  it("requires measured windows to cover only the period after observation began", () => {
    const oldWindow = sample(70_000, {
      window: { start: new Date(started - 60_000).toISOString(), end: new Date(started + 70_000).toISOString() },
    })
    expect(
      evaluateMetricObservation(policy, [target], [oldWindow], startedAt, undefined, started + 70_000).status,
    ).toBe("waiting")
    const valid = sample(70_000, { window: { start: startedAt, end: new Date(started + 70_000).toISOString() } })
    expect(evaluateMetricObservation(policy, [target], [valid], startedAt, undefined, started + 70_000).status).toBe(
      "satisfied",
    )
  })

  it("does not use stale, other-source, future, or pre-start observations", () => {
    const records = [sample(-1), sample(70_000, { sourceId: "other-api" }), sample(50_000), sample(150_000)]
    expect(evaluateMetricObservation(policy, [target], records, startedAt, undefined, started + 100_000).status).toBe(
      "waiting",
    )
    expect(() => evaluateMetricObservation(policy, [target], [], startedAt, undefined, started - 1)).toThrow("future")
  })

  it("unavailable current collection prevents reuse of a prior successful observation", () => {
    const unavailable = collection(80_000, {
      results: [
        {
          sourceId: "signup-api",
          name: "signup-conversion",
          status: "unavailable",
          reason: "Authentication expired. Refresh the analytics token.",
        },
      ],
    })
    const result = evaluateMetricObservation(
      policy,
      [target],
      [sample(70_000)],
      startedAt,
      unavailable,
      started + 80_000,
    )
    expect(result.status).toBe("waiting")
    expect(result.assessments[0]?.reason).toContain("Authentication expired")
  })

  it("fails after a bounded observation period instead of looping indefinitely or accepting late results", () => {
    expect(
      evaluateMetricObservation(policy, [target], [], startedAt, collection(120_000), started + 120_000),
    ).toMatchObject({ status: "failed", deadline: new Date(started + 120_000).toISOString() })
    expect(
      evaluateMetricObservation(policy, [target], [sample(150_000)], startedAt, undefined, started + 150_000).status,
    ).toBe("failed")
  })

  it("fails configuration gaps or target unit mismatch rather than asking an LLM to judge them", () => {
    expect(
      evaluateMetricObservation(policy, [{ ...target, name: "revenue" }], [], startedAt, undefined, started).status,
    ).toBe("failed")
    expect(
      evaluateMetricObservation(policy, [{ ...target, unit: "percent" }], [], startedAt, undefined, started).status,
    ).toBe("failed")
  })

  it("compares source-attributed baseline/current values for goals without a fixed threshold", () => {
    const improvement = { ...target, target: undefined }
    const before = sample(-10_000, { value: 0.1 })
    const after = sample(70_000, { value: 0.2 })
    const result = evaluateMetricObservation(
      policy,
      [improvement],
      [before, after],
      startedAt,
      undefined,
      started + 70_000,
    )
    expect(result).toMatchObject({
      status: "satisfied",
      assessments: [{ passed: true, baseline: { id: before.id }, current: { id: after.id } }],
    })
    expect(
      evaluateMetricObservation(policy, [improvement], [after], startedAt, undefined, started + 70_000).status,
    ).toBe("failed")
    expect(
      evaluateMetricObservation(
        policy,
        [improvement],
        [before, sample(70_000, { value: 0.05 })],
        startedAt,
        undefined,
        started + 70_000,
      ).status,
    ).toBe("failed")
    expect(
      evaluateMetricObservation(
        policy,
        [{ ...improvement, direction: "decrease" }],
        [before, sample(70_000, { value: 0.05 })],
        startedAt,
        undefined,
        started + 70_000,
      ).status,
    ).toBe("satisfied")
  })

  it("rejects incomparable baseline/current measurement durations", () => {
    const before = sample(-1_000, {
      value: 0.1,
      window: { start: new Date(started - 61_000).toISOString(), end: new Date(started - 1_000).toISOString() },
    })
    const after = sample(70_000, { window: { start: startedAt, end: new Date(started + 70_000).toISOString() } })
    const result = evaluateMetricObservation(
      policy,
      [{ ...target, target: undefined }],
      [before, after],
      startedAt,
      undefined,
      started + 70_000,
    )
    expect(result.status).toBe("failed")
    expect(result.assessments[0]?.reason).toContain("duration")
  })

  it("uses a pinned pre-work baseline without replacing it with post-work refreshes", () => {
    const before = sample(-60_000, { value: 0.1 })
    const postWork = sample(-1_000, { value: 0.24 })
    const after = sample(70_000)
    const result = evaluateMetricObservation(
      policy,
      [{ ...target, target: undefined }],
      [before, postWork, after],
      startedAt,
      undefined,
      started + 70_000,
      { "signup-api": before.id },
    )
    expect(result.status).toBe("satisfied")
    expect(result.assessments[0]?.baseline?.id).toBe(before.id)
  })
})
