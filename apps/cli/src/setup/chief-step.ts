import type { ReportDestination } from "@agent-valley/core/chief/report-delivery-contract"
import { type ChiefConfig, chiefConfigSchema } from "@agent-valley/core/config/chief-schema"
import * as p from "@clack/prompts"
import { stepMetrics } from "./metric-step"
import { BACK, CANCEL, type SetupContext, type StepResult } from "./types"
import { stepLabel } from "./ui"

type Channel = "slack" | "discord" | "telegram" | "teams" | "google-chat" | "mattermost" | "webhook"
type EnvField = Exclude<keyof ReportDestination, "id" | "channel">
const CHANNELS: { value: Channel; label: string }[] = [
  { value: "slack", label: "Slack" },
  { value: "discord", label: "Discord" },
  { value: "telegram", label: "Telegram" },
  { value: "teams", label: "Microsoft Teams" },
  { value: "google-chat", label: "Google Chat" },
  { value: "mattermost", label: "Mattermost" },
  { value: "webhook", label: "Custom webhook" },
]
const API_FIELDS: Partial<Record<Channel, EnvField[]>> = {
  slack: ["token_env", "channel_id_env"],
  telegram: ["token_env", "chat_id_env"],
  teams: ["token_env", "team_id_env", "channel_id_env"],
  "google-chat": ["token_env", "space_env"],
  mattermost: ["token_env", "base_url_env", "channel_id_env"],
}
const ENV_SUFFIXES: Record<EnvField, string> = {
  url_env: "WEBHOOK_URL",
  token_env: "BOT_TOKEN",
  chat_id_env: "CHAT_ID",
  channel_id_env: "CHANNEL_ID",
  space_env: "SPACE",
  team_id_env: "TEAM_ID",
  drive_id_env: "DRIVE_ID",
  base_url_env: "BASE_URL",
}

async function environmentField(channel: Channel, field: EnvField, previous?: string): Promise<string | StepResult> {
  const value = await p.text({
    message: `${channel}: ${field} (environment variable name; :back goes back)`,
    initialValue: previous ?? `${channel.replaceAll("-", "_").toUpperCase()}_${ENV_SUFFIXES[field]}`,
    validate: (input) => {
      if (input === ":back") return
      if (!input || !/^[A-Z_][A-Z0-9_]*$/.test(input))
        return "Enter an environment variable name such as SLACK_BOT_TOKEN, never its secret value."
    },
  })
  if (p.isCancel(value)) return CANCEL
  return value === ":back" ? BACK : value
}

async function reportingDestination(
  channel: Channel,
  capture: boolean,
  previous?: ReportDestination,
): Promise<ReportDestination | StepResult> {
  let mode = API_FIELDS[channel] ? "api" : "webhook"
  if (API_FIELDS[channel] && channel !== "telegram" && !capture) {
    const selected = await p.select({
      message: `${channel}: delivery connection`,
      initialValue: previous?.url_env ? "webhook" : "api",
      options: [
        { value: "api", label: "API", hint: "Supports reports and capture file uploads" },
        { value: "webhook", label: "Incoming webhook", hint: "Text reports; file uploads require API setup" },
        { value: "back", label: "Back" },
      ],
    })
    if (p.isCancel(selected)) return CANCEL
    if (selected === "back") return BACK
    mode = selected as string
  }
  const fields: EnvField[] = mode === "webhook" ? ["url_env"] : [...(API_FIELDS[channel] ?? [])]
  if (channel === "teams" && capture) fields.push("drive_id_env")
  const destination: ReportDestination = { id: previous?.id ?? channel, channel }
  for (const field of fields) {
    const value = await environmentField(channel, field, previous?.[field])
    if (value === BACK || value === CANCEL || value === undefined) return value
    destination[field] = value
  }
  if (channel === "webhook") {
    const token = await p.text({
      message: "Webhook bearer token environment variable (optional; blank omits it; :back goes back)",
      initialValue: previous?.token_env,
      validate: (value) => {
        if (value && value !== ":back" && !/^[A-Z_][A-Z0-9_]*$/.test(value))
          return "Enter an environment variable name, never its secret value."
      },
    })
    if (p.isCancel(token)) return CANCEL
    if (token === ":back") return BACK
    if (token) destination.token_env = token
  }
  return destination
}

async function captureSettings(previous?: ChiefConfig["capture"]): Promise<ChiefConfig["capture"] | StepResult> {
  const binding = await p.select({
    message: "Browser capture with Aside (optional)",
    initialValue: previous?.enabled ? (previous.tab_id ? "tab" : "url") : "off",
    options: [
      { value: "off", label: "Disabled" },
      { value: "url", label: "Bind a target URL" },
      { value: "tab", label: "Bind an existing Aside tab ID" },
      { value: "back", label: "Back" },
    ],
  })
  if (p.isCancel(binding)) return CANCEL
  if (binding === "back") return BACK
  if (binding === "off") return { ...previous, enabled: false } as ChiefConfig["capture"]
  const target = await p.text({
    message: binding === "url" ? "Capture target URL (:back goes back)" : "Aside tab ID (:back goes back)",
    initialValue: binding === "url" ? previous?.target_url : previous?.tab_id,
    validate: (value) => {
      if (value === ":back") return
      if (!value || value.length > (binding === "url" ? 4_096 : 200)) return "Enter the capture target."
      if (binding === "url") {
        try {
          const url = new URL(value)
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
            return "Use an HTTP(S) URL without embedded credentials."
        } catch {
          return "Use a valid HTTP(S) target URL."
        }
      }
    },
  })
  if (p.isCancel(target)) return CANCEL
  if (target === ":back") return BACK
  const video = await p.confirm({
    message: "Create a video from captured frames? (requires ffmpeg on PATH)",
    initialValue: previous?.video ?? true,
  })
  if (p.isCancel(video)) return CANCEL
  p.note(
    "Capture requires the Aside browser/MCP binding at mission runtime. Install or configure Aside separately; video also requires ffmpeg. Setup does not open a browser or test capture.",
    "Capture runtime requirements",
  )
  return {
    ...previous,
    enabled: true,
    target_url: binding === "url" ? target : undefined,
    tab_id: binding === "tab" ? target : undefined,
    video,
  } as ChiefConfig["capture"]
}

/** Optional integrations are configured without installing, reading secrets, or contacting a channel. */
export async function stepChief(ctx: SetupContext, step: number, total: number): Promise<StepResult> {
  const configured =
    !!ctx.chief?.reporting?.destinations.length || !!ctx.chief?.capture?.enabled || !!ctx.chief?.metric_sources
  const action = await p.select({
    message: stepLabel(step, total, "Optional reports, browser capture and metrics"),
    initialValue: "keep",
    options: [
      {
        value: "keep",
        label: configured ? "Keep current settings" : "Set up later",
        hint: configured ? "Preserve existing integrations" : "Integrations remain disabled",
      },
      { value: "configure", label: "Configure reporting and capture" },
      { value: "metrics", label: "Configure a business metric and target" },
      { value: "disable", label: "Disable reporting and capture" },
      { value: "back", label: "Back" },
    ],
  })
  if (p.isCancel(action)) return CANCEL
  if (action === "back") return BACK
  if (action === "keep") return
  if (action === "metrics") return stepMetrics(ctx)
  if (action === "disable") {
    ctx.chief = chiefConfigSchema.parse({ ...ctx.chief, reporting: { destinations: [] }, capture: { enabled: false } })
    ctx.chiefChanged = true
    return
  }
  if (action !== "configure") return CANCEL
  p.note(
    "Only environment variable names are saved. Export their values before running av order. No test messages are sent during setup. Routing remains configurable in av.yaml.",
    "Optional integrations",
  )
  const selected = await p.multiselect({
    message: "Report channels (completed and failed missions; select none for capture only)",
    options: CHANNELS,
    initialValues: CHANNELS.filter(({ value }) =>
      ctx.chief?.reporting?.destinations.some((entry) => entry.channel === value),
    ).map(({ value }) => value),
    required: false,
  })
  if (p.isCancel(selected)) return CANCEL
  const capture = await captureSettings(ctx.chief?.capture)
  if (capture === BACK || capture === CANCEL || capture === undefined) return capture
  const destinations: ReportDestination[] = []
  for (const channel of selected) {
    const destination = await reportingDestination(
      channel,
      capture.enabled,
      ctx.chief?.reporting?.destinations.find((entry) => entry.channel === channel),
    )
    if (destination === BACK || destination === CANCEL || destination === undefined) return destination
    destinations.push(destination)
  }
  ctx.chief = chiefConfigSchema.parse({
    ...ctx.chief,
    reporting: { ...ctx.chief?.reporting, destinations },
    capture,
  })
  ctx.chiefChanged = true
  p.log.info(
    "Integration settings are saved after confirmation. Runtime credentials and capture readiness remain unverified.",
  )
}
