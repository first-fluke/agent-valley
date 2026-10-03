import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  collectBusinessMetricSources,
  type MetricSourceAdapter,
  type MetricSourcePolicy,
  metricSourcePolicySchema,
  refreshBusinessMetricSources,
} from "./metric-sources"
import { listBusinessMetrics, recordCollectedBusinessMetric } from "./organization-metrics"

let repository: string
const now = Date.parse("2026-10-01T12:00:00Z")
const measured = "2026-10-01T11:59:55Z"
const observation = { value: 0.25, unit: "fraction", timestamp: measured }
const configuration = (overrides: Record<string, unknown> = {}): MetricSourcePolicy =>
  metricSourcePolicySchema.parse({
    sources: [
      {
        id: "signup-api",
        name: "signup-conversion",
        unit: "fraction",
        url_env: "ANALYTICS_URL",
        token_env: "ANALYTICS_TOKEN",
        ...overrides,
      },
    ],
  })
const dependencies = (fetch: typeof globalThis.fetch) => ({
  fetch,
  now: () => now,
  env: { ANALYTICS_URL: "https://analytics.example.test/private?scope=funnel", ANALYTICS_TOKEN: "fake-test-token" },
})
beforeEach(async () => {
  repository = await mkdtemp(join(tmpdir(), "av-metric-sources-"))
})
afterEach(async () => {
  await rm(repository, { recursive: true, force: true })
})

describe("real read-only business metric collection", () => {
  it("reads the configured API and persists source attribution without endpoint credentials", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ metrics: [observation] })))
    const result = await collectBusinessMetricSources(
      repository,
      configuration({
        value_path: "metrics.0.value",
        timestamp_path: "metrics.0.timestamp",
        unit_path: "metrics.0.unit",
      }),
      dependencies(fetch),
    )
    expect(fetch).toHaveBeenCalledWith(
      "https://analytics.example.test/private?scope=funnel",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: { Accept: "application/json", Authorization: "Bearer fake-test-token" },
      }),
    )
    expect(result.results[0]).toMatchObject({
      status: "collected",
      sample: {
        name: "signup-conversion",
        value: 0.25,
        unit: "fraction",
        sourceId: "signup-api",
        timestamp: measured,
        collectedAt: new Date(now).toISOString(),
        provenance: "source-collected",
      },
    })
    const stored = await listBusinessMetrics(repository)
    expect(stored).toHaveLength(1)
    const serialized = JSON.stringify(stored)
    expect(serialized).not.toContain("fake-test-token")
    expect(serialized).not.toContain("analytics.example.test")
    const directory = join(repository, ".agent-valley", "organization", "metrics")
    const files = await readdir(directory)
    expect(await readFile(join(directory, files[0] as string), "utf8")).not.toContain("fake-test-token")
  })

  it("deduplicates identical source/time observations across refresh and concurrent writers", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => new Response(JSON.stringify(observation)))
    const policy = configuration()
    await Promise.all(
      Array.from({ length: 8 }, () => collectBusinessMetricSources(repository, policy, dependencies(fetch))),
    )
    const later = await collectBusinessMetricSources(repository, policy, {
      ...dependencies(fetch),
      now: () => now + 1_000,
    })
    expect(later.results[0]?.status).toBe("unchanged")
    expect(await listBusinessMetrics(repository)).toHaveLength(1)
    expect(later.results[0]?.sample?.collectedAt).toBe(new Date(now).toISOString())
  })

  it("rejects revised evidence at the same timestamp without overwriting a stored observation", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(observation)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...observation, value: 10 })))
    await collectBusinessMetricSources(repository, configuration(), dependencies(fetch))
    const revised = await collectBusinessMetricSources(repository, configuration(), dependencies(fetch))
    expect(revised.results[0]).toMatchObject({ status: "failed", reason: expect.stringContaining("changed evidence") })
    expect((await listBusinessMetrics(repository))[0]?.value).toBe(0.25)
  })

  it.each([
    [{ ...observation, value: "0.25" }, "failed"],
    [{ ...observation, value: null }, "failed"],
    [{ ...observation, unit: "percent" }, "failed"],
    [{ ...observation, timestamp: "2026-10-01T12:00:01Z" }, "failed"],
    [{ ...observation, timestamp: "2026-10-01T10:00:00Z" }, "unavailable"],
    [{ value: 0.5, unit: "fraction" }, "failed"],
  ])("never records unusable observed data %j", async (data, status) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(data)))
    const result = await collectBusinessMetricSources(repository, configuration(), dependencies(fetch))
    expect(result.results[0]?.status).toBe(status)
    expect(await listBusinessMetrics(repository)).toEqual([])
  })

  it.each([401, 403, 429, 503])(
    "leaves unavailable provider HTTP %s without inventing fallback samples",
    async (status) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("provider-secret-data", { status }))
      const result = await collectBusinessMetricSources(repository, configuration(), dependencies(fetch))
      expect(result.results[0]).toMatchObject({
        status: "unavailable",
        reason: expect.stringContaining(`HTTP ${status}`),
      })
      expect(JSON.stringify(result)).not.toContain("provider-secret-data")
      expect(await listBusinessMetrics(repository)).toEqual([])
    },
  )

  it("requires configured credentials and rejects unsafe or redirected endpoints", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const absent = await collectBusinessMetricSources(repository, configuration(), { fetch, env: {}, now: () => now })
    expect(absent.results[0]?.status).toBe("unavailable")
    expect(fetch).not.toHaveBeenCalled()
    for (const url of [
      "http://analytics.example.test/",
      "https://secret:credential@example.test/",
      "https://example.test/#fragment",
    ]) {
      const result = await collectBusinessMetricSources(repository, configuration(), {
        ...dependencies(fetch),
        env: { ANALYTICS_URL: url, ANALYTICS_TOKEN: "secret" },
      })
      expect(result.results[0]?.status).toBe("failed")
      expect(JSON.stringify(result)).not.toContain(url)
    }
    expect(fetch).not.toHaveBeenCalled()
    fetch.mockRejectedValue(new Error("https://secret-url.example.test/ raw token=secret"))
    const failure = await collectBusinessMetricSources(repository, configuration(), dependencies(fetch))
    expect(JSON.stringify(failure)).not.toContain("secret-url")
  })

  it("bounds response bodies even without a content length", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("x".repeat(2_000_001)))
    const result = await collectBusinessMetricSources(repository, configuration(), dependencies(fetch))
    expect(result.results[0]).toMatchObject({ status: "failed", reason: expect.stringContaining("2 MB") })
    expect(await listBusinessMetrics(repository)).toEqual([])
  })

  it("preserves and validates an explicit measurement window", async () => {
    const data = { ...observation, period: { from: "2026-10-01T11:00:00Z", to: measured } }
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(data)))
    const result = await collectBusinessMetricSources(
      repository,
      configuration({ window_start_path: "period.from", window_end_path: "period.to" }),
      dependencies(fetch),
    )
    expect(result.results[0]?.sample?.window).toEqual({ start: data.period.from, end: measured })
    const staleWindow = { ...data, period: { from: "2026-10-01T08:00:00Z", to: "2026-10-01T09:00:00Z" } }
    fetch.mockResolvedValue(new Response(JSON.stringify(staleWindow)))
    expect(
      (
        await collectBusinessMetricSources(
          repository,
          configuration({ window_start_path: "period.from", window_end_path: "period.to" }),
          dependencies(fetch),
        )
      ).results[0]?.status,
    ).toBe("unavailable")
  })

  it("refreshes actual samples into repository context", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(observation)))
    const refreshed = await refreshBusinessMetricSources(
      repository,
      "Improve signup conversion",
      configuration(),
      [{ name: "signup-conversion", unit: "fraction", direction: "increase", target: 0.2 }],
      dependencies(fetch),
    )
    expect(refreshed.samples).toHaveLength(1)
    expect(refreshed.context.metrics[0]?.provenance).toBe("source-collected")
  })
})

describe("swappable local and custom metric sources", () => {
  it("reads actual repository JSON exports and rejects file or directory symlinks and path escapes", async () => {
    await mkdir(join(repository, "analytics"))
    await writeFile(join(repository, "analytics", "metrics.json"), JSON.stringify(observation))
    const policy = configuration({ adapter: "json-file", file: "analytics/metrics.json" })
    expect((await collectBusinessMetricSources(repository, policy, { now: () => now })).results[0]?.status).toBe(
      "collected",
    )
    await symlink(join(repository, "analytics", "metrics.json"), join(repository, "linked.json"))
    await symlink(join(repository, "analytics"), join(repository, "linked-dir"))
    for (const file of ["linked.json", "linked-dir/metrics.json", "../outside.json", "/tmp/outside.json"]) {
      const result = await collectBusinessMetricSources(repository, configuration({ adapter: "json-file", file }), {
        now: () => now,
      })
      expect(result.results[0]?.status).toBe("failed")
    }
    expect(
      (
        await collectBusinessMetricSources(repository, configuration({ adapter: "json-file", file: "missing.json" }), {
          now: () => now,
        })
      ).results[0]?.status,
    ).toBe("unavailable")
  })

  it("supports injected source adapters and bounds a hung adapter", async () => {
    const adapter: MetricSourceAdapter = { collect: vi.fn().mockResolvedValue(observation) }
    const registry = new Map([["custom-analytics", adapter]])
    const policy = configuration({ adapter: "custom-analytics", timeout_ms: 100 })
    expect(
      (await collectBusinessMetricSources(repository, policy, { registry, now: () => now })).results[0]?.status,
    ).toBe("collected")
    const missing = await collectBusinessMetricSources(repository, policy, { now: () => now })
    expect(missing.results[0]?.status).toBe("unavailable")
    const hung: MetricSourceAdapter = { collect: () => new Promise(() => {}) }
    const timedOut = await collectBusinessMetricSources(repository, policy, {
      registry: new Map([["custom-analytics", hung]]),
      now: () => now,
    })
    expect(timedOut.results[0]).toMatchObject({ status: "unavailable", reason: expect.stringContaining("timed out") })
  })

  it("checks freshness at response receipt and aborts promptly without persisting a cancelled observation", async () => {
    const clock = vi
      .fn()
      .mockReturnValueOnce(now)
      .mockReturnValue(now + 5_000)
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ...observation, timestamp: new Date(now + 4_000).toISOString() })),
      )
    const result = await collectBusinessMetricSources(repository, configuration(), {
      ...dependencies(fetch),
      now: clock,
    })
    expect(result.results[0]?.status).toBe("collected")
    expect(result.results[0]?.sample?.collectedAt).toBe(new Date(now + 5_000).toISOString())
    const controller = new AbortController()
    const adapter: MetricSourceAdapter = { collect: () => new Promise(() => {}) }
    const pending = collectBusinessMetricSources(repository, configuration({ adapter: "hung", timeout_ms: 60_000 }), {
      registry: new Map([["hung", adapter]]),
      signal: controller.signal,
      now: () => now,
    })
    controller.abort()
    const interrupted = await pending
    expect(interrupted.results[0]).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("interrupted"),
    })
    expect(await listBusinessMetrics(repository)).toHaveLength(1)
  })

  it("validates policy secrets, duplicate identities, JSON paths and observation limits", () => {
    expect(() => configuration({ url_env: "https://secret.example.test" })).toThrow()
    expect(() => configuration({ value_path: "__proto__.value" })).toThrow()
    expect(() => configuration({ window_start_path: "period.from" })).toThrow()
    const source = configuration().sources[0]
    expect(() => metricSourcePolicySchema.parse({ sources: [source, source] })).toThrow("unique")
    expect(() =>
      metricSourcePolicySchema.parse({ sources: [source], observation_window_ms: 10_000, max_observation_ms: 1_000 }),
    ).toThrow()
  })

  it("rejects racing contradictory measurements rather than silently accepting both", async () => {
    const inputs = [0.25, 0.9].map((value) => ({
      name: "signup-conversion",
      unit: "fraction",
      source: "metric-source:signup-api:http-json",
      sourceId: "signup-api",
      value,
      timestamp: measured,
      collectedAt: new Date(now).toISOString(),
    }))
    const result = await Promise.allSettled(
      inputs.map((input) => recordCollectedBusinessMetric(repository, input, now)),
    )
    expect(result.filter((entry) => entry.status === "fulfilled")).toHaveLength(1)
    expect(result.filter((entry) => entry.status === "rejected")).toHaveLength(1)
    expect(await listBusinessMetrics(repository)).toHaveLength(1)
  })
})
