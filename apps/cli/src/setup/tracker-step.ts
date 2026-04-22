/**
 * Step: choose the issue tracker (Linear or GitHub).
 *
 * Downstream steps branch off this selection. Linear keeps the legacy
 * flow; GitHub routes into the github-step module.
 */

import * as p from "@clack/prompts"
import { CANCEL, type SetupContext, type StepResult } from "./types"
import { stepLabel } from "./ui"

export async function stepTrackerKind(ctx: SetupContext, step: number, total: number): Promise<StepResult> {
  const kind = await p.select({
    message: stepLabel(step, total, "Tracker kind"),
    initialValue: ctx.trackerKind ?? "linear",
    options: [
      { value: "linear", label: "Linear", hint: "Linear.app — GraphQL + webhooks" },
      { value: "github", label: "GitHub", hint: "GitHub Issues — REST + webhooks" },
    ],
  })
  if (p.isCancel(kind)) return CANCEL

  ctx.trackerKind = kind as "linear" | "github"
  return
}
