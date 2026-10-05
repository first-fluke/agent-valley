import {
  type ContainerObservationTarget,
  containerObservationPolicySchema,
  containerObservationTargetSchema,
} from "@agent-valley/core/chief/container-observation-policy"
import { chiefConfigSchema } from "@agent-valley/core/config/chief-schema"
import * as p from "@clack/prompts"
import { BACK, CANCEL, type SetupContext, type StepResult } from "./types"

type Input = string | StepResult
const dockerFields = containerObservationTargetSchema.options[0].shape
const kubernetesFields = containerObservationTargetSchema.options[1].shape

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
const field = (schema: { safeParse(value: unknown): { success: boolean } }, message: string) => (value: string) =>
  schema.safeParse(value).success ? undefined : message
function requirements(): void {
  p.note(
    "When enabled, the selected targets must be healthy before a mission can complete. AV reads status, health, restarts, OOM events, resource usage and bounded logs at runtime. Setup only saves configuration; it does not connect, authenticate, start a daemon or run a model. Enter target/context names, never credentials.",
    "Container observation requirements",
  )
}

/** Save explicit target requirements without contacting a container runtime or cluster. */
export async function stepContainers(ctx: SetupContext): Promise<StepResult> {
  const previous = ctx.chief?.container_observation
  const targets = previous?.targets ?? []
  const options = [
    { value: "keep", label: "Keep current settings" },
    ...(targets.length < 20 ? [{ value: "add", label: "Add an explicit target" }] : []),
    ...(targets.length
      ? [
          { value: "replace", label: "Replace an existing target" },
          previous?.enabled === false
            ? { value: "enable", label: "Enable the existing targets" }
            : { value: "disable", label: "Disable container observation" },
        ]
      : []),
    { value: "back", label: "Back" },
  ]
  const action = await p.select({
    message: "Container observation targets",
    initialValue: previous ? "keep" : "add",
    options,
  })
  if (p.isCancel(action)) return CANCEL
  if (action === "back") return BACK
  if (action === "keep") return
  if (action === "disable" || action === "enable") {
    if (!previous) return CANCEL
    if (action === "enable") requirements()
    ctx.chief = chiefConfigSchema.parse({
      ...ctx.chief,
      container_observation: { ...previous, enabled: action === "enable" },
    })
    ctx.chiefChanged = true
    return
  }
  let old: ContainerObservationTarget | undefined
  if (action === "replace") {
    const selected = await p.select({
      message: "Select the target to replace",
      options: [
        ...targets.map((target) => ({ value: target.id, label: target.id })),
        { value: ":back", label: "Back" },
      ],
    })
    if (p.isCancel(selected)) return CANCEL
    if (selected === ":back") return BACK
    old = targets.find((target) => target.id === selected)
    if (!old) return CANCEL
  } else if (action !== "add" || targets.length >= 20) return CANCEL
  requirements()
  const id = await text("Target ID", old?.id ?? "service", (value) => {
    if (!dockerFields.id.safeParse(value).success)
      return "Enter a target ID using letters, numbers, dots, dashes or underscores."
    if (targets.some((target) => target.id === value && target.id !== old?.id))
      return "This target ID already exists. Choose a unique ID or explicitly replace that target."
  })
  if (navigated(id)) return id
  const kind = await p.select({
    message: "Container runtime",
    initialValue: old?.kind ?? "docker",
    options: [
      { value: "docker", label: "Docker / OrbStack", hint: "Uses the docker CLI and selected Docker context" },
      { value: "kubernetes", label: "Kubernetes", hint: "Uses kubectl for one named Pod and container" },
      { value: "back", label: "Back" },
    ],
  })
  if (p.isCancel(kind)) return CANCEL
  if (kind === "back") return BACK
  if (kind !== "docker" && kind !== "kubernetes") return CANCEL
  const context = await text(
    kind === "docker" ? "Docker context (optional; OrbStack usually uses orbstack)" : "Kubernetes context (optional)",
    old?.kind === kind ? (old.context ?? "") : "",
    (value) =>
      !value || dockerFields.context.safeParse(value).success
        ? undefined
        : "Enter an existing CLI context name without flags or credentials.",
  )
  if (navigated(context)) return context
  const draft: Record<string, unknown> = { id, kind, ...(context ? { context } : {}) }
  if (kind === "kubernetes") {
    for (const key of ["namespace", "pod"] as const) {
      const value = await text(
        key === "namespace" ? "Kubernetes namespace" : "Exact Kubernetes Pod name",
        old?.kind === "kubernetes" ? old[key] : key === "namespace" ? "default" : "",
        field(
          kubernetesFields[key],
          `Enter an explicit Kubernetes ${key} name; selectors and CLI flags are not accepted.`,
        ),
      )
      if (navigated(value)) return value
      draft[key] = value
    }
  }
  const container = await text(
    kind === "docker" ? "Exact Docker container name or ID" : "Exact container name inside the Pod",
    old?.container ?? "",
    field(dockerFields.container, "Enter an explicit container name or ID without CLI flags."),
  )
  if (navigated(container)) return container
  draft.container = container
  const policy: Record<string, unknown> = { ...previous, enabled: true }
  for (const [key, message, fallback] of [
    ["poll_interval_sec", "Container polling interval in seconds", 30],
    ["log_tail", "Maximum log lines per target", 50],
    ["log_since_sec", "Log lookback window in seconds", 300],
  ] as const) {
    const schema = containerObservationPolicySchema.shape[key]
    const value = await text(message, String(previous?.[key] ?? fallback), (input) => {
      const result = schema.safeParse(input ? Number(input) : NaN)
      return result.success
        ? undefined
        : `Enter a bounded whole number for ${key}. ${result.error.issues[0]?.message ?? "Use the allowed range."}`
    })
    if (navigated(value)) return value
    policy[key] = Number(value)
  }
  const target = containerObservationTargetSchema.parse(draft)
  policy.targets = old ? targets.map((entry) => (entry.id === old.id ? target : entry)) : [...targets, target]
  ctx.chief = chiefConfigSchema.parse({
    ...ctx.chief,
    container_observation: containerObservationPolicySchema.parse(policy),
  })
  ctx.chiefChanged = true
  p.log.info(
    "Container observation settings are saved after confirmation. Only the named targets are observed; runtime connectivity, authentication and health remain unverified.",
  )
}
