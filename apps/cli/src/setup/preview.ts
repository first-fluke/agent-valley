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
  lines.push(`  agent.type             = ${pc.cyan(ctx.agentType)}`)
  lines.push("")

  lines.push(pc.bold("Project") + pc.dim(" (valley.yaml)"))
  lines.push(`  tracker.kind           = ${pc.cyan(ctx.trackerKind)}`)

  if (ctx.trackerKind === "linear") {
    lines.push(`  linear.team_id         = ${ctx.linear.selectedTeam.key}`)
    lines.push(`  linear.team_uuid       = ${pc.dim(ctx.linear.teamUuid)}`)
    lines.push(`  linear.webhook_secret  = ${pc.dim(maskApiKey(ctx.linear.webhookSecret))}`)
  } else {
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
  lines.push(`  delivery.mode          = merge`)
  lines.push(`  tunnel.provider        = ${pc.cyan(ctx.tunnel.provider)}`)
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
