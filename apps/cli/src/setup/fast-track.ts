/**
 * Fast-track flow for new team members. When an invite is detected in
 * the clipboard (Linear-only today), we collect just the three personal
 * values and reuse the team's shared Linear config.
 */

import * as p from "@clack/prompts"
import pc from "picocolors"
import type { InviteData } from "../invite"
import { stepApiKey } from "./linear-step"
import { stepParallel } from "./parallel-step"
import { renderPreview } from "./preview"
import { resolveContext } from "./resolve"
import { saveConfig } from "./save"
import { BACK, CANCEL, type SetupContext } from "./types"
import { stepWorkspace } from "./workspace-step"

export async function fastTrackSetup(invite: InviteData): Promise<void> {
  p.log.info(pc.green("Invite data detected. Loading team configuration."))

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
    agentType: (invite.agentType as SetupContext["agentType"]) ?? "claude",
  }

  const fastSteps = [stepApiKey, stepWorkspace, stepParallel]
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

  await saveConfig(resolved.ctx)
  p.outro(pc.green("Setup complete! Start the server with `bun av up`."))
}
