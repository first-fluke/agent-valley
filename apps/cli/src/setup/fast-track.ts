/**
 * Fast-track flow for new team members. When an invite is detected in
 * the clipboard (Linear-only today), we collect just the three personal
 * values and reuse the team's shared Linear config.
 */

import { mergeChiefConfig } from "@agent-valley/core/config/chief-schema"
import { loadProjectConfig } from "@agent-valley/core/config/yaml-loader"
import * as p from "@clack/prompts"
import pc from "picocolors"
import type { InviteData } from "../invite"
import { stepAgentType } from "./agent-step"
import { stepChief } from "./chief-step"
import { stepCompletion } from "./completion-step"
import { GLOBAL_CONFIG_REPAIR_WARNING, readSetupGlobalConfig } from "./global-settings"
import { stepApiKey } from "./linear-step"
import { stepOma } from "./oma-step"
import { stepParallel } from "./parallel-step"
import { renderPreview } from "./preview"
import { resolveContext } from "./resolve"
import { saveConfig } from "./save"
import { BACK, CANCEL, type SetupContext } from "./types"
import { stepWorkspace } from "./workspace-step"

export async function fastTrackSetup(
  invite: InviteData,
  options: { replaceInvalidGlobal?: boolean } = {},
): Promise<void> {
  p.log.info(pc.green("Invite data detected. Loading team configuration."))

  const globalSettings = readSetupGlobalConfig()
  if (globalSettings.invalid && !options.replaceInvalidGlobal) p.log.warn(GLOBAL_CONFIG_REPAIR_WARNING)
  const defaults = globalSettings.config.agent
  let projectChief: SetupContext["chief"]
  let replaceInvalidProject = false
  try {
    projectChief = loadProjectConfig()?.chief
  } catch {
    replaceInvalidProject = true
    p.log.warn("Existing av.yaml cannot be read. Confirm the new configuration to replace it.")
  }
  const ctx: SetupContext = {
    trackerKind: "linear",
    linear: {
      teamUuid: invite.teamUuid,
      selectedTeam: { id: invite.teamUuid, key: invite.teamId, name: invite.teamId },
      webhookSecret: invite.webhookSecret,
      todoStateId: invite.todoStateId,
      inProgressStateId: invite.inProgressStateId,
      doneStateId: invite.doneStateId,
      cancelledStateId: invite.cancelledStateId,
    },
    agentType: defaults?.type ?? (invite.agentType as SetupContext["agentType"]) ?? "claude",
    agentModel: defaults?.model,
    chief: mergeChiefConfig(globalSettings.config.chief, projectChief),
  }

  const fastSteps = [stepApiKey, stepWorkspace, stepAgentType, stepOma, stepChief, stepParallel, stepCompletion]
  const totalSteps = fastSteps.length
  let i = 0
  while (i < fastSteps.length) {
    const step = fastSteps[i]
    if (!step) break
    const result = await step(ctx, i + 1, totalSteps)
    if (result === BACK) {
      i = Math.max(0, i - 1)
      continue
    }
    if (result === CANCEL) {
      p.cancel("Cancelled")
      process.exit(0)
    }
    i++
  }

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

  await saveConfig(resolved.ctx, {
    replaceInvalidGlobal: globalSettings.invalid || options.replaceInvalidGlobal,
    replaceInvalidProject,
  })
  p.outro(pc.green("Setup complete! Start the server with `bun av up`."))
}
