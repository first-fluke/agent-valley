import { z } from "zod"
import { metricSourceEnvironment, readMetricJson } from "./metric-source-adapters"
import { type MetricSourceAdapter, MetricSourceError } from "./metric-source-policy"

const chargeSchema = z.object({
  id: z.string().min(1),
  created: z.number().int().nonnegative(),
  currency: z.string(),
  amount_captured: z.number().int().nonnegative().safe(),
  amount_refunded: z.number().int().nonnegative().safe(),
  paid: z.boolean(),
  captured: z.boolean(),
  livemode: z.boolean(),
  disputed: z.boolean(),
})
const pageSchema = z.object({ data: z.array(chargeSchema).max(100), has_more: z.boolean() })
/** Charges created in a rolling window: captured amount less refunds, excluding disputes and test mode.
 * This measures charge cohort revenue, not settlement, profit, fees, or causal attribution.
 * https://docs.stripe.com/api/charges/list ; https://docs.stripe.com/api/charges/object
 */
export const stripeRevenueMetricAdapter: MetricSourceAdapter = {
  async collect(request) {
    const token = metricSourceEnvironment(request, request.source.token_env)
    if (!/^(?:sk|rk)_live_/.test(token))
      throw new MetricSourceError(
        "Stripe business observations require a live read-enabled API key in token_env. Test data cannot satisfy a business goal.",
        true,
      )
    const end = Math.floor(request.now / 1_000)
    const start = Math.floor((request.now - request.source.window_ms) / 1_000)
    const seen = new Set<string>()
    let totalMinor = 0
    let cursor: string | undefined
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const url = new URL("https://api.stripe.com/v1/charges")
      url.searchParams.set("limit", "100")
      url.searchParams.set("created[gte]", String(start))
      url.searchParams.set("created[lte]", String(end))
      if (cursor) url.searchParams.set("starting_after", cursor)
      const parsed = pageSchema.safeParse(
        await readMetricJson(
          await request.fetch(url.href, {
            method: "GET",
            headers: {
              Authorization: `Basic ${Buffer.from(`${token}:`).toString("base64")}`,
              Accept: "application/json",
            },
            signal: request.signal,
            redirect: "error",
          }),
        ),
      )
      if (!parsed.success)
        throw new MetricSourceError(
          "Stripe returned incomplete charge evidence. Check the API version and read permissions.",
        )
      const page = parsed.data
      for (const charge of page.data) {
        if (seen.has(charge.id) || charge.created < start || charge.created > end || !charge.livemode)
          throw new MetricSourceError(
            "Stripe returned duplicate, out-of-window or test charge evidence. Refresh a complete live observation.",
          )
        seen.add(charge.id)
        if (
          !charge.paid ||
          !charge.captured ||
          charge.disputed ||
          charge.currency !== request.source.currency.toLowerCase()
        )
          continue
        if (charge.amount_refunded > charge.amount_captured)
          throw new MetricSourceError(
            "Stripe refund evidence exceeds captured amount. Inspect the charge before using its revenue.",
          )
        totalMinor += charge.amount_captured - charge.amount_refunded
        if (!Number.isSafeInteger(totalMinor))
          throw new MetricSourceError("Stripe revenue exceeds a safe numeric range. Use a smaller measurement window.")
      }
      if (!page.has_more)
        return {
          value: totalMinor / 100,
          unit: request.source.currency,
          timestamp: new Date(end * 1_000).toISOString(),
          window: { start: new Date(start * 1_000).toISOString(), end: new Date(end * 1_000).toISOString() },
        }
      if (!page.data.length)
        throw new MetricSourceError("Stripe pagination did not provide a continuation. Retry a complete observation.")
      cursor = page.data.at(-1)?.id
    }
    throw new MetricSourceError(
      "Stripe observation exceeds 10000 charges. Reduce window_ms; incomplete revenue is never recorded.",
    )
  },
}
