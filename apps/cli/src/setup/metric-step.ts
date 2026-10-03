import { isAbsolute } from "node:path"
import { type MetricSource, metricSourceSchema } from "@agent-valley/core/chief/metric-source-policy"
import { chiefConfigSchema } from "@agent-valley/core/config/chief-schema"
import * as p from "@clack/prompts"
import { BACK, CANCEL, type SetupContext, type StepResult } from "./types"

type Input = string | StepResult
const envName = (value: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
async function text(
  message: string,
  initialValue: string,
  validate: (value: string) => string | undefined,
): Promise<Input> {
  const value = await p.text({
    message: `${message} (:back goes back)`,
    initialValue,
    validate: (input) => (input === ":back" ? undefined : validate(input?.trim() ?? "")),
  })
  if (p.isCancel(value)) return CANCEL
  return value === ":back" ? BACK : value.trim()
}
const navigated = (value: Input): value is StepResult => typeof value !== "string"
const required = (limit: number) => (value: string) =>
  value && value.length <= limit ? undefined : `Enter 1 to ${limit} characters.`
const environment =
  (optional = false) =>
  (value: string) =>
    (optional && !value) || envName(value) ? undefined : "Enter an environment variable name, never a token or URL."
const number = (minimum: number, maximum: number) => (value: string) =>
  value && Number.isInteger(Number(value)) && Number(value) >= minimum && Number(value) <= maximum
    ? undefined
    : `Enter a whole number from ${minimum} to ${maximum}.`
const path = (value: string) => {
  const result = metricSourceSchema.shape.value_path.safeParse(value)
  return result.success ? undefined : "Use dot-separated JSON keys or array indexes, without prototype keys."
}

/** Configure one authoritative source and target; existing other metrics and Chief settings remain intact. */
export async function stepMetrics(ctx: SetupContext): Promise<StepResult> {
  const existing = ctx.chief
  const prior = existing?.metric_sources?.sources[0]
  const name = await text("Metric name", prior?.name ?? existing?.metric_targets?.[0]?.name ?? "revenue", (value) => {
    const error = required(120)(value)
    if (error) return error
    if (
      !existing?.metric_sources?.sources.some((source) => source.name === value) &&
      (existing?.metric_sources?.sources.length ?? 0) >= 20
    )
      return "Edit an existing metric name; at most 20 sources can be configured."
    if (
      !existing?.metric_targets?.some((target) => target.name === value) &&
      (existing?.metric_targets?.length ?? 0) >= 20
    )
      return "Edit an existing target name; at most 20 targets can be configured."
  })
  if (navigated(name)) return name
  const old = existing?.metric_sources?.sources.find((source) => source.name === name)
  const target = existing?.metric_targets?.find((target) => target.name === name)
  const adapter = await p.select({
    message: "Metric data source",
    initialValue: ["http-json", "json-file", "stripe-revenue"].includes(old?.adapter ?? "")
      ? old?.adapter
      : "http-json",
    options: [
      { value: "http-json", label: "HTTP JSON", hint: "Read a JSON measurement from an endpoint" },
      { value: "json-file", label: "Repository JSON file", hint: "Read a measurement written by your data pipeline" },
      {
        value: "stripe-revenue",
        label: "Stripe charge revenue",
        hint: "Captured charges less refunds in a fixed window",
      },
      { value: "back", label: "Back" },
    ],
  })
  if (p.isCancel(adapter)) return CANCEL
  if (adapter === "back") return BACK
  const draft: Record<string, unknown> = { ...old, id: old?.id ?? name, name, adapter }
  delete draft.url_env
  delete draft.token_env
  delete draft.file
  if (adapter === "stripe-revenue") {
    const currency = await p.select({
      message: "Stripe revenue currency",
      initialValue: old?.currency ?? "USD",
      options: ["USD", "EUR", "GBP", "AUD", "CAD"].map((value) => ({ value, label: value })),
    })
    if (p.isCancel(currency)) return CANCEL
    draft.currency = currency
    draft.unit = currency
    const token = await text(
      "Stripe API key environment variable",
      old?.token_env ?? "STRIPE_SECRET_KEY",
      environment(),
    )
    if (navigated(token)) return token
    draft.token_env = token
    const window = await text(
      "Stripe measurement window in seconds",
      String((old?.window_ms ?? 86_400_000) / 1_000),
      number(1, 31_536_000),
    )
    if (navigated(window)) return window
    draft.window_ms = Number(window) * 1_000
  } else {
    const unit = await text("Metric unit", old?.unit ?? target?.unit ?? "count", required(80))
    if (navigated(unit)) return unit
    draft.unit = unit
    if (adapter === "http-json") {
      const url = await text("Metric URL environment variable", old?.url_env ?? "AV_METRIC_URL", environment())
      if (navigated(url)) return url
      draft.url_env = url
      const token = await text(
        "Bearer token environment variable (optional; blank omits it)",
        old?.token_env ?? "",
        environment(true),
      )
      if (navigated(token)) return token
      if (token) draft.token_env = token
    } else {
      const file = await text("Repository-relative JSON file", old?.file ?? "metrics/revenue.json", (value) => {
        if (
          !value ||
          value.length > 2_000 ||
          isAbsolute(value) ||
          /^[A-Za-z]:/.test(value) ||
          value.startsWith("\\") ||
          value.split(/[\\/]/).includes("..")
        )
          return "Use a relative file inside the repository, without .."
      })
      if (navigated(file)) return file
      draft.file = file
    }
    for (const field of ["value_path", "timestamp_path", "unit_path"] as const) {
      const value = await text(`JSON ${field}`, old?.[field] ?? field.replace("_path", ""), path)
      if (navigated(value)) return value
      draft[field] = value
    }
    const start = await text(
      "JSON measurement window start path (optional; blank omits window)",
      old?.window_start_path ?? "",
      (value) => (value ? path(value) : undefined),
    )
    if (navigated(start)) return start
    delete draft.window_start_path
    delete draft.window_end_path
    if (start) {
      const end = await text("JSON measurement window end path", old?.window_end_path ?? "window.end", path)
      if (navigated(end)) return end
      draft.window_start_path = start
      draft.window_end_path = end
    }
  }
  const direction = await p.select({
    message: "Target direction",
    initialValue: target?.direction ?? "increase",
    options: [
      { value: "increase", label: "Increase" },
      { value: "decrease", label: "Decrease" },
      { value: "back", label: "Back" },
    ],
  })
  if (p.isCancel(direction)) return CANCEL
  if (direction === "back") return BACK
  const value = await text(
    "Target value (optional; blank requires improvement over the actual baseline)",
    target?.target === undefined ? "" : String(target.target),
    (input) =>
      !input || Number.isFinite(Number(input))
        ? undefined
        : "Enter a finite number or leave blank for measured improvement.",
  )
  if (navigated(value)) return value
  const observation = await text(
    "Required observation window in seconds",
    String((existing?.metric_sources?.observation_window_ms ?? 60_000) / 1_000),
    number(0, 604_800),
  )
  if (navigated(observation)) return observation
  const maximum = await text(
    "Maximum observation duration in seconds",
    String((existing?.metric_sources?.max_observation_ms ?? 259_200_000) / 1_000),
    number(Math.max(1, Number(observation)), 2_592_000),
  )
  if (navigated(maximum)) return maximum
  const source: MetricSource = metricSourceSchema.parse(draft)
  ctx.chief = chiefConfigSchema.parse({
    ...existing,
    metric_sources: {
      ...existing?.metric_sources,
      sources: [...(existing?.metric_sources?.sources ?? []).filter((entry) => entry.name !== name), source],
      observation_window_ms: Number(observation) * 1_000,
      max_observation_ms: Number(maximum) * 1_000,
    },
    metric_targets: [
      ...(existing?.metric_targets ?? []).filter((entry) => entry.name !== name),
      { name, unit: source.unit, direction, ...(value ? { target: Number(value) } : {}) },
    ],
  })
  ctx.chiefChanged = true
  p.log.info(
    "Metric settings are saved after confirmation. Measurements are collected at mission runtime; setup does not contact the source. Set --duration or chief.execution.max_duration_sec long enough for work and the full measurement/observation windows. The default mission limit is 86400 seconds including waits; Stripe's default measurement window is also 86400 seconds.",
  )
}
