import { chiefConfigSchema } from "@agent-valley/core/config/chief-schema"
import * as p from "@clack/prompts"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { stepChief } from "../../setup/chief-step"
import { stepMetrics } from "../../setup/metric-step"
import { renderPreview } from "../../setup/preview"
import { resolveContext } from "../../setup/resolve"
import { BACK, CANCEL, type SetupContext } from "../../setup/types"

vi.mock("@clack/prompts", () => ({
  select: vi.fn(),
  text: vi.fn(),
  isCancel: (value: unknown) => typeof value === "symbol",
  log: { info: vi.fn() },
}))
let adapter: "http-json" | "json-file" | "stripe-revenue"
let answers: Map<string, string>
const existing = () =>
  chiefConfigSchema.parse({
    review_vendor: "require",
    memory: false,
    metric_sources: {
      sources: [{ id: "latency-source", name: "latency", unit: "ms", adapter: "json-file", file: "latency.json" }],
    },
    metric_targets: [{ name: "latency", unit: "ms", direction: "decrease", target: 50 }],
    reporting: { destinations: [{ id: "report", channel: "slack", url_env: "SLACK_URL" }] },
    capture: { enabled: true, target_url: "https://example.test/app" },
  })
beforeEach(() => {
  vi.resetAllMocks()
  adapter = "http-json"
  answers = new Map([
    ["Metric name", "revenue"],
    ["Metric unit", "USD"],
    ["Target value (optional; blank requires improvement over the actual baseline)", "100"],
  ])
  vi.mocked(p.select).mockImplementation(async (args) => {
    if (args.message === "Metric data source") return adapter
    if (args.message.includes("Optional reports")) return "metrics"
    if (args.message === "Stripe revenue currency") return "USD"
    return "increase"
  })
  vi.mocked(p.text).mockImplementation(
    async (args) => answers.get(args.message.replace(" (:back goes back)", "")) ?? args.initialValue ?? "",
  )
})

describe("business metric setup", () => {
  it("connects the Chief metrics action and configures HTTP JSON while preserving other policies and metrics", async () => {
    const chief = existing()
    const ctx: SetupContext = { chief }
    answers.set("Metric URL environment variable", "REVENUE_URL")
    answers.set("Bearer token environment variable (optional; blank omits it)", "REVENUE_TOKEN")
    answers.set("JSON value_path", "results.0.amount")
    expect(await stepChief(ctx, 4, 5)).toBeUndefined()
    expect(ctx.chiefChanged).toBe(true)
    expect(ctx.chief?.metric_sources?.sources).toHaveLength(2)
    expect(ctx.chief?.metric_sources?.sources[1]).toMatchObject({
      name: "revenue",
      adapter: "http-json",
      unit: "USD",
      url_env: "REVENUE_URL",
      token_env: "REVENUE_TOKEN",
      value_path: "results.0.amount",
    })
    expect(ctx.chief?.metric_targets).toContainEqual({
      name: "revenue",
      unit: "USD",
      direction: "increase",
      target: 100,
    })
    expect(ctx.chief?.reporting).toEqual(chief.reporting)
    expect(ctx.chief?.capture).toEqual(chief.capture)
    expect(ctx.chief?.review_vendor).toBe("require")
    expect(ctx.chief?.memory).toBe(false)
    expect(chiefConfigSchema.safeParse(ctx.chief).success).toBe(true)
    const resolved = resolveContext({ ...ctx, trackerKind: "none", agentType: "codex", workspaceRoot: "/repo" })
    if (!resolved.ok) throw new Error(resolved.error)
    const preview = renderPreview(resolved.ctx)
    expect(preview).toContain("REVENUE_TOKEN (environment name only)")
    expect(preview).toContain("runtime collection pending")
    expect(preview).toContain("revenue: increase 100 USD")
  })

  it("configures a local JSON pipeline and an actual measurement window, without inventing a baseline", async () => {
    adapter = "json-file"
    const ctx: SetupContext = {}
    answers.set("Repository-relative JSON file", "measurements/business.json")
    answers.set("JSON measurement window start path (optional; blank omits window)", "window.start")
    answers.set("JSON measurement window end path", "window.end")
    answers.set("Target value (optional; blank requires improvement over the actual baseline)", "")
    await stepMetrics(ctx)
    expect(ctx.chief?.metric_sources?.sources[0]).toMatchObject({
      adapter: "json-file",
      file: "measurements/business.json",
      window_start_path: "window.start",
      window_end_path: "window.end",
    })
    expect(ctx.chief?.metric_targets?.[0]).toEqual({ name: "revenue", unit: "USD", direction: "increase" })
  })

  it("configures Stripe in the selected currency with only the credential's environment name", async () => {
    adapter = "stripe-revenue"
    const ctx: SetupContext = {}
    answers.set("Stripe API key environment variable", "BUSINESS_STRIPE_KEY")
    answers.set("Stripe measurement window in seconds", "3600")
    await stepMetrics(ctx)
    expect(ctx.chief?.metric_sources?.sources[0]).toMatchObject({
      adapter: "stripe-revenue",
      token_env: "BUSINESS_STRIPE_KEY",
      currency: "USD",
      unit: "USD",
      window_ms: 3_600_000,
    })
    expect(ctx.chief?.metric_sources?.sources[0]?.url_env).toBeUndefined()
    expect(p.log.info).toHaveBeenCalledWith(expect.stringContaining("does not contact the source"))
  })

  it("replaces one named metric without duplicating its source or target", async () => {
    const ctx: SetupContext = { chief: existing() }
    answers.set("Metric name", "latency")
    answers.set("Metric unit", "ms")
    await stepMetrics(ctx)
    expect(ctx.chief?.metric_sources?.sources).toHaveLength(1)
    expect(ctx.chief?.metric_sources?.sources[0]?.id).toBe("latency-source")
    expect(ctx.chief?.metric_targets).toHaveLength(1)
  })

  it.each([":back", Symbol("cancel")])(
    "leaves every setting untouched on navigation during target entry: %s",
    async (choice) => {
      const chief = existing()
      const ctx: SetupContext = { chief }
      vi.mocked(p.text).mockImplementation(async (args) => {
        if (args.message.startsWith("Target value")) return choice as Awaited<ReturnType<typeof p.text>>
        return answers.get(args.message.replace(" (:back goes back)", "")) ?? args.initialValue ?? ""
      })
      expect(await stepMetrics(ctx)).toBe(choice === ":back" ? BACK : CANCEL)
      expect(ctx).toEqual({ chief })
    },
  )

  it("validates environment names, JSON paths and observation bounds before persistence", async () => {
    await stepMetrics({})
    const validator = (prefix: string) => {
      const validate = vi.mocked(p.text).mock.calls.find(([args]) => args.message.startsWith(prefix))?.[0].validate
      if (typeof validate !== "function") throw new Error(`Missing validator ${prefix}`)
      return validate
    }
    expect(validator("Metric URL")("https://secret.example/token")).toContain("environment")
    expect(validator("Bearer token")("secret-token")).toContain("never a token")
    expect(validator("JSON value_path")("__proto__.polluted")).toContain("prototype")
    expect(validator("Target value")("Infinity")).toContain("finite")
    expect(validator("Maximum observation")("30")).toContain("60")
    expect(validator("Required observation")("-1")).toContain("whole number")
  })

  it("rejects absolute or escaping local JSON paths", async () => {
    adapter = "json-file"
    await stepMetrics({})
    const validate = vi
      .mocked(p.text)
      .mock.calls.find(([args]) => args.message.startsWith("Repository-relative"))?.[0].validate
    if (typeof validate !== "function") throw new Error("Missing file validator")
    for (const value of ["../secrets.json", "/etc/secrets.json", "C:\\secrets.json"])
      expect(validate(value)).toContain("relative file")
    expect(validate("metrics/business.json")).toBeUndefined()
  })
})
