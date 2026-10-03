/**
 * Interactive setup wizard — orchestrates the step modules, handles
 * clipboard fast-track, and persists the final configuration.
 *
 * Outputs:
 *   - ~/.config/agent-valley/settings.yaml (global — agent type, optional
 *     Linear API key)
 *   - ./av.yaml (project — tracker config, workspace, prompt)
 *
 * Features:
 *   - Tracker selection (Linear or GitHub)
 *   - Step-based loop with back navigation
 *   - Step progress indicator (Step N/M)
 *   - Webhook pause confirmation
 *   - Final preview with masked secrets
 *   - Fast track via invite clipboard detection (Linear only)
 *   - Partial reconfiguration (--edit mode)
 *
 * Layer: Presentation. No business logic — delegates to `@agent-valley/core`
 * for config schemas and to the Infrastructure adapters for runtime use.
 */

import { existsSync } from "node:fs"
import { mergeChiefConfig } from "@agent-valley/core/config/chief-schema"
import { resolveProjectConfigPath } from "@agent-valley/core/config/project-config-path"
import { loadProjectConfig, resolveGlobalConfigPath } from "@agent-valley/core/config/yaml-loader"
import * as p from "@clack/prompts"
import pc from "picocolors"
import { detectInviteFromClipboard } from "../invite"
import { stepAgentType } from "./agent-step"
import { stepChief } from "./chief-step"
import { stepCompletion } from "./completion-step"
import { fastTrackSetup } from "./fast-track"
import { stepGithubLabels, stepGithubRepo, stepGithubToken, stepGithubWebhookSecret } from "./github-step"
import { GLOBAL_CONFIG_REPAIR_WARNING, readSetupGlobalConfig } from "./global-settings"
import { stepApiKey, stepTeam, stepWebhook, stepWorkflowStates } from "./linear-step"
import { stepOma } from "./oma-step"
import { stepParallel } from "./parallel-step"
import { renderPreview } from "./preview"
import { resolveContext } from "./resolve"
import { saveConfig } from "./save"
import { stepTrackerKind } from "./tracker-step"
import { stepTunnel } from "./tunnel-step"
import { BACK, CANCEL, type SetupContext, type StepFn } from "./types"
import { stepWorkspace } from "./workspace-step"

// Re-exports for callers (tests / other CLI modules) that used the
// flat `./setup` import path before the split.
export { setupEdit } from "./edit"
export { findWorkflowState, linearQuery } from "./linear-api"
export { maskApiKey } from "./mask"
export type { LinearTeam, WorkflowState } from "./types"
export { buildGlobalYaml, buildProjectYaml } from "./yaml-build"

function linearSteps(): StepFn[] {
  return [stepApiKey, stepTeam, stepWorkflowStates, stepWebhook]
}

function githubSteps(): StepFn[] {
  return [stepGithubToken, stepGithubRepo, stepGithubWebhookSecret, stepGithubLabels]
}

function commonSteps(): StepFn[] {
  return [stepWorkspace, stepTunnel, stepAgentType, stepOma, stepChief, stepParallel, stepCompletion]
}

function buildStepList(kind: SetupContext["trackerKind"]): StepFn[] {
  if (kind === "none") return [stepWorkspace, stepAgentType, stepOma, stepChief, stepCompletion]
  if (kind === "github") return [...githubSteps(), ...commonSteps()]
  return [...linearSteps(), ...commonSteps()]
}

async function runStepLoop(ctx: SetupContext): Promise<void> {
  if (ctx.trackerKind !== "none") {
    while (true) {
      const result = await stepTrackerKind(ctx, 1, 1)
      if (result === CANCEL) {
        p.cancel("Cancelled")
        process.exit(0)
      }
      if (result !== BACK) break
    }
  }
  let steps = buildStepList(ctx.trackerKind)
  let i = 0
  while (i < steps.length) {
    const step = steps[i]
    if (!step) break
    const result = await step(ctx, i + 1, steps.length)
    if (result === BACK) {
      if (i === 0 && ctx.trackerKind !== "none") {
        // Back from the first main step returns to tracker selection.
        const rerun = await stepTrackerKind(ctx, 1, 1)
        if (rerun === CANCEL) {
          p.cancel("Cancelled")
          process.exit(0)
        }
        steps = buildStepList(ctx.trackerKind)
        continue
      }
      i = Math.max(0, i - 1)
      continue
    }
    if (result === CANCEL) {
      p.cancel("Cancelled")
      process.exit(0)
    }
    i++
  }
}

function printGithubTokenHint(tokenEnv: string): void {
  const shellHint = `export ${tokenEnv}='<paste your PAT here>'`
  p.note(
    [
      `The GitHub token was NOT written to any file. Set it in your shell:`,
      "",
      `  ${pc.bold(shellHint)}`,
      "",
      `Then restart any running \`av\` processes. Symphony reads \`${tokenEnv}\` at startup via github.token_env.`,
    ].join("\n"),
    "Next: export your GitHub token",
  )
}

export async function setup(options: { mode?: "order" | "tracker" } = {}): Promise<void> {
  const mode = options.mode ?? "order"
  p.intro(pc.bgCyan(pc.black(" Agent Valley Setup ")))

  const hasGlobal = existsSync(resolveGlobalConfigPath())
  const hasProject = existsSync(resolveProjectConfigPath(process.cwd()))

  if (hasGlobal && hasProject) {
    const overwrite = await p.confirm({ message: "Config files already exist. Overwrite?" })
    if (p.isCancel(overwrite) || !overwrite) {
      p.cancel("Cancelled")
      process.exit(0)
    }
  } else if (hasGlobal) {
    p.log.info(pc.dim("Global config found. Only project setup needed."))
  }

  const globalSettings = readSetupGlobalConfig()
  if (globalSettings.invalid) p.log.warn(GLOBAL_CONFIG_REPAIR_WARNING)

  // Detect invite in clipboard — Linear-only shortcut.
  const invite = mode === "tracker" ? await detectInviteFromClipboard() : null
  if (invite) {
    const useInvite = await p.confirm({ message: "Invite data detected in clipboard. Use it?" })
    if (!p.isCancel(useInvite) && useInvite) {
      return fastTrackSetup(invite, { replaceInvalidGlobal: globalSettings.invalid })
    }
  }

  // Pre-populate from existing global config.
  const ctx: SetupContext =
    mode === "order" ? { trackerKind: "none", maxParallel: 1, tunnel: { provider: "none" } } : {}
  const existing = globalSettings.config
  if (existing.linear?.api_key) ctx.linear = { apiKey: existing.linear.api_key }
  ctx.agentType = existing.agent?.type
  ctx.agentModel = existing.agent?.model
  ctx.chief = existing.chief
  let replaceInvalidProject = false
  if (hasProject) {
    try {
      const existing = loadProjectConfig()
      ctx.workspaceRoot = existing?.workspace?.root
      ctx.verifyCommand = existing?.verify?.command
      ctx.task = existing?.task
      ctx.chief = mergeChiefConfig(ctx.chief, existing?.chief)
    } catch {
      replaceInvalidProject = true
      p.log.warn("Existing av.yaml cannot be read. Re-enter the workspace and verification settings to replace it.")
    }
  }

  await runStepLoop(ctx)

  const resolved = resolveContext(ctx)
  if (!resolved.ok) {
    p.log.error(resolved.error)
    process.exit(1)
  }

  p.note(renderPreview(resolved.ctx), "Configuration Review")

  const confirmed = await p.confirm({ message: "Save this configuration?" })
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("Cancelled")
    process.exit(0)
  }

  await saveConfig(resolved.ctx, { replaceInvalidGlobal: globalSettings.invalid, replaceInvalidProject })

  if (resolved.ctx.trackerKind === "github") {
    printGithubTokenHint(resolved.ctx.github.tokenEnv)
  }

  p.outro(
    pc.green(
      mode === "order"
        ? 'Setup complete! Run `av order "your goal"` to start.'
        : "Setup complete! Start the server with `bun av up`.",
    ),
  )
}
