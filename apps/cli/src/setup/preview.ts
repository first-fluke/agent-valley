/**
 * Render the pre-save configuration preview with secrets masked.
 *
 * Masking policy:
 *   - Linear API key   → keep prefix + last 4 (recognisable for ops).
 *   - Linear webhook   → mask (`****xxxx`).
 *   - GitHub token     → never shown (stored in env only); only its env
 *                         var name is printed.
 *   - GitHub webhook   → mask (`****xxxx`).
 */

import { resolveGlobalConfigPath } from "@agent-valley/core/config/yaml-loader"
import pc from "picocolors"
import { maskApiKey, maskSecret } from "./mask"
import type { ResolvedSetupContext } from "./resolve"

export function renderPreview(ctx: ResolvedSetupContext): string {
  const globalPath = resolveGlobalConfigPath()
  const lines: string[] = []

  lines.push(pc.bold("Global") + pc.dim(` (${globalPath})`))
  if (ctx.trackerKind === "linear") {
    lines.push(`  linear.api_key         = ${pc.dim(maskApiKey(ctx.linear.apiKey))}`)
  }
  lines.push(`  actor.type             = ${pc.cyan(ctx.agentType)}`)
  lines.push(`  actor.model            = ${ctx.agentModel ?? "CLI default"}`)
  lines.push("")

  lines.push(pc.bold("Project") + pc.dim(" (av.yaml)"))
  if (ctx.trackerKind !== "none") lines.push(`  tracker.kind           = ${pc.cyan(ctx.trackerKind)}`)

  if (ctx.trackerKind === "linear") {
    lines.push(`  linear.team_id         = ${ctx.linear.selectedTeam.key}`)
    lines.push(`  linear.team_uuid       = ${pc.dim(ctx.linear.teamUuid)}`)
    lines.push(`  linear.webhook_secret  = ${pc.dim(maskApiKey(ctx.linear.webhookSecret))}`)
  } else if (ctx.trackerKind === "github") {
    lines.push(`  github.token_env       = ${pc.cyan(ctx.github.tokenEnv)} ${pc.dim("(token lives in env only)")}`)
    lines.push(`  github.owner           = ${ctx.github.owner}`)
    lines.push(`  github.repo            = ${ctx.github.repo}`)
    lines.push(`  github.webhook_secret  = ${pc.dim(maskSecret(ctx.github.webhookSecret))}`)
    lines.push(`  github.labels.todo         = ${ctx.github.labels.todo}`)
    lines.push(`  github.labels.in_progress  = ${ctx.github.labels.inProgress}`)
    lines.push(`  github.labels.done         = ${ctx.github.labels.done}`)
    lines.push(`  github.labels.cancelled    = ${ctx.github.labels.cancelled}`)
  }

  lines.push(`  workspace.root         = ${ctx.workspaceRoot}`)
  if (ctx.trackerKind !== "none") lines.push(`  delivery.mode          = merge`)
  if (ctx.trackerKind !== "none" || ctx.task) lines.push(`  task.kind              = ${ctx.task?.kind ?? "code"}`)
  if (ctx.task?.kind === "analysis") lines.push(`  task.report_path       = ${ctx.task.report_path}`)
  if (ctx.verifyCommand) lines.push(`  verify.command         = ${ctx.verifyCommand}`)
  else if (ctx.trackerKind === "none") lines.push("  verification           = Chief-designed checks for each goal")
  const destinations = ctx.chief?.reporting?.destinations ?? []
  lines.push(
    `  chief.reporting        = ${destinations.length ? destinations.map((entry) => entry.channel).join(", ") : "disabled"}`,
  )
  for (const destination of destinations)
    for (const [field, value] of Object.entries(destination))
      if (field.endsWith("_env")) lines.push(`    ${destination.id}.${field} = ${value} (environment name only)`)
  lines.push(`  chief.capture          = ${ctx.chief?.capture?.enabled ? "enabled (runtime unverified)" : "disabled"}`)
  if (ctx.chief?.capture?.enabled) {
    if (ctx.chief.capture.target_url) lines.push(`    target_url           = ${ctx.chief.capture.target_url}`)
    if (ctx.chief.capture.tab_id) lines.push(`    tab_id               = ${ctx.chief.capture.tab_id}`)
    lines.push(`    video                = ${ctx.chief.capture.video ? "yes (requires ffmpeg)" : "no"}`)
  }
  const metrics = ctx.chief?.metric_sources
  if (metrics) {
    lines.push(`  chief.metric_sources   = ${metrics.sources.length} source(s); runtime collection pending`)
    for (const source of metrics.sources) {
      lines.push(`    ${source.name} = ${source.adapter} (${source.unit})`)
      if (source.file) lines.push(`    file = ${source.file}`)
      for (const [field, value] of Object.entries(source))
        if (field.endsWith("_env")) lines.push(`    ${field} = ${value} (environment name only)`)
    }
    lines.push(`    observation_window_ms = ${metrics.observation_window_ms}`)
    lines.push(`    max_observation_ms = ${metrics.max_observation_ms}`)
  }
  for (const target of ctx.chief?.metric_targets ?? [])
    lines.push(
      `  metric target          = ${target.name}: ${target.direction} ${target.target ?? "from measured baseline"} ${target.unit ?? ""}`.trimEnd(),
    )
  const containers = ctx.chief?.container_observation
  lines.push(`  chief.container_observation = ${containers?.enabled ? "enabled (runtime unverified)" : "disabled"}`)
  if (containers) {
    for (const target of containers.targets) {
      const location =
        target.kind === "docker"
          ? `container=${target.container}`
          : `namespace=${target.namespace} pod=${target.pod} container=${target.container}`
      lines.push(`    ${target.id} = ${target.kind} ${location} context=${target.context ?? "CLI default"}`)
    }
    lines.push(`    poll_interval_sec = ${containers.poll_interval_sec}`)
    lines.push(`    log_tail = ${containers.log_tail}; log_since_sec = ${containers.log_since_sec}`)
    lines.push(`    timeout_ms = ${containers.timeout_ms}; max_output_bytes = ${containers.max_output_bytes}`)
    if (containers.cpu_percent_threshold !== undefined)
      lines.push(`    cpu_percent_threshold = ${containers.cpu_percent_threshold}`)
    if (containers.memory_percent_threshold !== undefined)
      lines.push(`    memory_percent_threshold = ${containers.memory_percent_threshold}`)
    lines.push(
      containers.enabled
        ? "    completion requirement = all selected targets must be healthy"
        : "    completion requirement = disabled; targets retained for later editing",
    )
  }
  if (ctx.trackerKind !== "none") lines.push(`  tunnel.provider        = ${pc.cyan(ctx.tunnel.provider)}`)
  if (ctx.tunnel.provider === "cloudflare") {
    const cf = ctx.tunnel.cloudflare
    lines.push(`  tunnel.cloudflare.mode = ${cf?.mode ?? "quick"}`)
    if (cf?.mode === "named") {
      lines.push(`  tunnel.cloudflare.name = ${cf.name ?? pc.red("(missing)")}`)
      if (cf.hostname) lines.push(`  tunnel.cloudflare.host = ${cf.hostname}`)
    }
  }
  return lines.join("\n")
}
