/**
 * Interactive setup wizard — orchestrates the step modules, handles
 * clipboard fast-track, and persists the final configuration.
 *
 * Outputs:
 *   - ~/.config/agent-valley/settings.yaml (global — agent type, optional
 *     Linear API key)
 *   - ./valley.yaml (project — tracker config, workspace, prompt)
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
import { loadGlobalConfig, resolveGlobalConfigPath } from "@agent-valley/core/config/yaml-loader"
import * as p from "@clack/prompts"
import pc from "picocolors"
import { detectInviteFromClipboard } from "../invite"
import { stepAgentType } from "./agent-step"
import { fastTrackSetup } from "./fast-track"
import { stepGithubLabels, stepGithubRepo, stepGithubToken, stepGithubWebhookSecret } from "./github-step"
import { stepApiKey, stepTeam, stepWebhook, stepWorkflowStates } from "./linear-step"
import { stepParallel } from "./parallel-step"
import { renderPreview } from "./preview"
import { resolveContext } from "./resolve"
import { saveConfig } from "./save"
import { stepTrackerKind } from "./tracker-step"
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
  return [stepWorkspace, stepAgentType, stepParallel]
}

function buildStepList(kind: SetupContext["trackerKind"]): StepFn[] {
  if (kind === "github") return [...githubSteps(), ...commonSteps()]
  return [...linearSteps(), ...commonSteps()]
}

async function runStepLoop(ctx: SetupContext): Promise<void> {
  // Two-phase loop: tracker-kind is step 1 on its own, then branch into
  // the tracker-specific step list. We rebuild the list whenever the
  // user goes BACK to the tracker step and changes kind.
  let phase: "tracker" | "main" = "tracker"
  let steps: StepFn[] = []
  let i = 0

  // Run the tracker selection first.
  while (true) {
    const trackerTotal = 1
    const result = await stepTrackerKind(ctx, 1, trackerTotal)
    if (result === CANCEL) {
      p.cancel("Cancelled")
      process.exit(0)
    }
    if (result === BACK) continue // No previous step — retry.
    break
  }

  phase = "main"
  steps = buildStepList(ctx.trackerKind)
  const mainTotal = steps.length
  i = 0
  while (i < steps.length) {
    const step = steps[i]
    if (!step) break
    const result = await step(ctx, i + 1, mainTotal)
    if (result === BACK) {
      if (i === 0) {
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
  // Silence unused-variable in strict mode: phase transitions are for
  // readability of the flow above.
  void phase
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

export async function setup(): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" Agent Valley Setup ")))

  const hasGlobal = existsSync(resolveGlobalConfigPath())
  const hasProject = existsSync("valley.yaml")

  if (hasGlobal && hasProject) {
    const overwrite = await p.confirm({ message: "Config files already exist. Overwrite?" })
    if (p.isCancel(overwrite) || !overwrite) {
      p.cancel("Cancelled")
      process.exit(0)
    }
  } else if (hasGlobal) {
    p.log.info(pc.dim("Global config found. Only project setup needed."))
  }

  // Detect invite in clipboard — Linear-only shortcut.
  const invite = await detectInviteFromClipboard()
  if (invite) {
    const useInvite = await p.confirm({ message: "Invite data detected in clipboard. Use it?" })
    if (!p.isCancel(useInvite) && useInvite) {
      return fastTrackSetup(invite)
    }
  }

  // Pre-populate from existing global config.
  const ctx: SetupContext = {}
  if (hasGlobal) {
    try {
      const existing = loadGlobalConfig()
      if (existing) {
        if (existing.linear?.api_key) {
          ctx.linear = { apiKey: existing.linear.api_key }
        }
        ctx.agentType = existing.agent?.type
      }
    } catch {
      // Ignore — the new setup will overwrite.
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

  await saveConfig(resolved.ctx)

  if (resolved.ctx.trackerKind === "github") {
    printGithubTokenHint(resolved.ctx.github.tokenEnv)
  }

  p.outro(pc.green("Setup complete! Start the server with `bun av up`."))
}
