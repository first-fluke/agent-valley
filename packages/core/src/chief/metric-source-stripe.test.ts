import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { collectBusinessMetricSources, metricSourcePolicySchema } from "./metric-sources"
import { listBusinessMetrics } from "./organization-metrics"

let repository: string
const now = Date.parse("2026-10-01T12:00:00Z")
const second = Math.floor(now / 1_000)
const policy = metricSourcePolicySchema.parse({
  sources: [
    {
      id: "stripe-sales",
      adapter: "stripe-revenue",
      name: "daily-revenue",
      unit: "USD",
      token_env: "STRIPE_READ_KEY",
      window_ms: 86_400_000,
    },
  ],
})
const charge = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  created: second - 60,
  currency: "usd",
  amount_captured: 1_000,
  amount_refunded: 100,
  paid: true,
  captured: true,
  livemode: true,
  disputed: false,
  ...overrides,
})
const dependencies = (fetch: typeof globalThis.fetch, token = "rk_live_fake_test_fixture") => ({
  fetch,
  now: () => now,
  env: { STRIPE_READ_KEY: token },
})
beforeEach(async () => {
  repository = await mkdtemp(join(tmpdir(), "av-stripe-metrics-"))
})
afterEach(async () => {
  await rm(repository, { recursive: true, force: true })
})

describe("Stripe read-only revenue source", () => {
  it("fully paginates a charge cohort and measures captured amounts less refunds in one currency", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [charge("charge-first"), charge("charge-refunded", { amount_refunded: 1_000 })],
            has_more: true,
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              charge("charge-last", { amount_captured: 2_000 }),
              charge("other-currency", { currency: "eur" }),
              charge("unpaid", { paid: false }),
              charge("disputed", { disputed: true }),
            ],
            has_more: false,
          }),
        ),
      )
    const result = await collectBusinessMetricSources(repository, policy, dependencies(fetch))
    expect(result.results[0]).toMatchObject({
      status: "collected",
      sample: {
        value: 28,
        unit: "USD",
        provenance: "source-collected",
        sourceId: "stripe-sales",
        window: { start: new Date(now - 86_400_000).toISOString(), end: new Date(now).toISOString() },
      },
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    const firstUrl = new URL(fetch.mock.calls[0]?.[0] as string)
    expect(firstUrl.origin).toBe("https://api.stripe.com")
    expect(firstUrl.searchParams.get("created[gte]")).toBe(String(second - 86_400))
    expect(firstUrl.searchParams.get("limit")).toBe("100")
    expect(new URL(fetch.mock.calls[1]?.[0] as string).searchParams.get("starting_after")).toBe("charge-refunded")
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "error" })
    expect(JSON.stringify(await listBusinessMetrics(repository))).not.toContain("rk_live")
  })

  it("records zero only when the actual complete live API response has no charges", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ data: [], has_more: false })))
    expect(
      (await collectBusinessMetricSources(repository, policy, dependencies(fetch))).results[0]?.sample?.value,
    ).toBe(0)
    const unavailable = await collectBusinessMetricSources(repository, policy, { now: () => now, env: {} })
    expect(unavailable.results[0]?.sample).toBeUndefined()
  })

  it("rejects test credentials and test-mode evidence from completion criteria", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    expect(
      (await collectBusinessMetricSources(repository, policy, dependencies(fetch, "sk_test_fixture"))).results[0]
        ?.status,
    ).toBe("unavailable")
    expect(fetch).not.toHaveBeenCalled()
    fetch.mockResolvedValue(
      new Response(JSON.stringify({ data: [charge("test-charge", { livemode: false })], has_more: false })),
    )
    expect((await collectBusinessMetricSources(repository, policy, dependencies(fetch))).results[0]?.status).toBe(
      "failed",
    )
    expect(await listBusinessMetrics(repository)).toEqual([])
  })

  it.each([
    { data: [charge("outside", { created: second - 90_000 })], has_more: false },
    { data: [charge("future", { created: second + 1 })], has_more: false },
    { data: [charge("duplicate"), charge("duplicate")], has_more: false },
    { data: [], has_more: true },
    { data: [charge("refund", { amount_refunded: 2_000 })], has_more: false },
    { data: [{ id: "incomplete" }], has_more: false },
  ])("never persists incomplete or invalid charge aggregates %j", async (response) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(response)))
    const result = await collectBusinessMetricSources(repository, policy, dependencies(fetch))
    expect(result.results[0]?.status).toBe("failed")
    expect(await listBusinessMetrics(repository)).toEqual([])
  })
})
