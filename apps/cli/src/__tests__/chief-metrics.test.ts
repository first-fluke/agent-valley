import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { metricSourcePolicySchema } from "@agent-valley/core/chief/metric-sources"
import { addOrganizationMemory, listBusinessMetrics } from "@agent-valley/core/chief/organization"
import { mission as missionFixture } from "@agent-valley/core/chief/reports.fixture"
import type { Mission } from "@agent-valley/core/chief/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMissionMetricPorts } from "../chief-metrics"

let repository: string
let now: number
const started = Date.parse("2026-10-01T12:00:00Z")
const sourcePolicy = metricSourcePolicySchema.parse({
  sources: [
    {
      id: "signup-source",
      name: "signup-conversion",
      unit: "fraction",
      url_env: "ANALYTICS_URL",
      token_env: "ANALYTICS_TOKEN",
      max_age_ms: 30_000,
      poll_interval_ms: 10_000,
    },
  ],
  observation_window_ms: 60_000,
  max_observation_ms: 120_000,
})
function mission(): Mission & { metricBaselineIds?: Record<string, string> } {
  return {
    ...missionFixture(),
    repositoryRoot: repository,
    status: "pending",
    history: [],
    metricSourcePolicy: sourcePolicy,
    operatingPolicy: {
      memory: true,
      reviewVendor: "prefer",
      readyActors: [],
      metricTargets: [{ name: "signup-conversion", unit: "fraction", direction: "increase" }],
    },
  }
}
const response = (value: number, offset: number) =>
  new Response(JSON.stringify({ value, unit: "fraction", timestamp: new Date(started + offset).toISOString() }))
const dependencies = (fetch: typeof globalThis.fetch) => ({
  fetch,
  now: () => now,
  env: { ANALYTICS_URL: "https://metrics.example.test/funnel", ANALYTICS_TOKEN: "fake-fixture-token" },
})
beforeEach(async () => {
  repository = await mkdtemp(join(tmpdir(), "av-chief-metrics-"))
  now = started - 1_000
})
afterEach(async () => {
  await rm(repository, { recursive: true, force: true })
})

describe("Chief automatic metric observation ports", () => {
  it("captures exact pre-work baseline and resumes without rebasing it onto later observations", async () => {
    const current = mission()
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(0.1, -1_000))
    const ports = createMissionMetricPorts(repository, current, dependencies(fetch))
    await ports.initialize()
    const baseline = current.metricBaselineIds?.["signup-source"]
    expect(baseline).toBeDefined()
    expect(current.organizationContext?.metrics[0]?.value).toBe(0.1)
    await ports.initialize()
    expect(fetch).toHaveBeenCalledTimes(1)
    now = started + 1_000
    fetch.mockResolvedValue(response(0.15, 1_000))
    await createMissionMetricPorts(repository, current, dependencies(fetch)).initialize()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(current.metricBaselineIds?.["signup-source"]).toBe(baseline)
  })

  it("waits for new source evidence after verification and reports satisfied only after the observation window", async () => {
    const current = mission()
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(0.1, -1_000))
    const ports = createMissionMetricPorts(repository, current, dependencies(fetch))
    await ports.initialize()
    current.observationStartedAt = new Date(started).toISOString()
    now = started + 10_000
    fetch.mockResolvedValue(response(0.5, 10_000))
    expect(await ports.observeMetrics(current)).toMatchObject({
      status: "waiting",
      nextPollAt: new Date(now + 10_000).toISOString(),
    })
    now = started + 70_000
    fetch.mockResolvedValue(response(0.25, 70_000))
    expect(await ports.observeMetrics(current)).toMatchObject({
      status: "satisfied",
      reason: expect.stringContaining("before=0.1, after=0.25"),
    })
    expect(current.organizationContext?.metrics.map((sample) => sample.value)).toEqual([0.1, 0.25])
    expect(await listBusinessMetrics(repository)).toHaveLength(3)
  })

  it("keeps business metrics while memory is disabled", async () => {
    await addOrganizationMemory(repository, { kind: "stack-standard", content: "Use PostgreSQL" })
    const current = mission()
    if (current.operatingPolicy) current.operatingPolicy.memory = false
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response(0.1, -1_000))
    const ports = createMissionMetricPorts(repository, current, dependencies(fetch))
    await ports.initialize()
    const context = await ports.refreshOrganization(current)
    expect(context.memories).toEqual([])
    expect(context.outcomes).toEqual([])
    expect(context.experiments).toEqual([])
    expect(context.routeEvidence).toEqual([])
    expect(context.metrics[0]?.provenance).toBe("source-collected")
  })

  it("unavailable sources never fabricate baselines, pass on old values, or leak response secrets", async () => {
    const current = mission()
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("fake-provider-secret", { status: 401 }))
    const ports = createMissionMetricPorts(repository, current, dependencies(fetch))
    await ports.initialize()
    expect(current.metricBaselineIds).toEqual({})
    expect(current.history[0]?.message).toContain("HTTP 401")
    expect(JSON.stringify(current)).not.toContain("fake-provider-secret")
    current.observationStartedAt = new Date(started).toISOString()
    now = started + 70_000
    expect((await ports.observeMetrics(current)).status).toBe("waiting")
    now = started + 120_000
    expect((await ports.observeMetrics(current)).status).toBe("failed")
    expect(await listBusinessMetrics(repository)).toEqual([])
  })

  it("requires configured goals and a persisted observation start", async () => {
    const current = mission()
    const ports = createMissionMetricPorts(repository, current, dependencies(vi.fn<typeof globalThis.fetch>()))
    expect((await ports.observeMetrics(current)).status).toBe("failed")
    current.observationStartedAt = new Date(started).toISOString()
    if (current.operatingPolicy) current.operatingPolicy.metricTargets = []
    expect((await ports.observeMetrics(current)).status).toBe("failed")
    current.metricSourcePolicy = undefined
    expect((await ports.observeMetrics(current)).status).toBe("satisfied")
  })

  it("does not convert corrupt metric storage into goal success", async () => {
    const current = mission()
    current.observationStartedAt = new Date(started).toISOString()
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(0.5, 70_000))
    await symlink(repository, join(repository, ".agent-valley"))
    now = started + 70_000
    const ports = createMissionMetricPorts(repository, current, dependencies(fetch))
    expect(await ports.observeMetrics(current)).toMatchObject({
      status: "waiting",
      reason: expect.stringContaining("storage"),
    })
    now = started + 120_000
    expect((await ports.observeMetrics(current)).status).toBe("failed")
    expect(fetch).not.toHaveBeenCalled()
  })
})
