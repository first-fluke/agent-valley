/**
 * Workspace root selection. Shared by Linear and GitHub flows.
 */

import * as p from "@clack/prompts"
import { CANCEL, type SetupContext, type StepResult } from "./types"
import { stepLabel } from "./ui"

export async function stepWorkspace(ctx: SetupContext, step: number, total: number): Promise<StepResult> {
  const defaultWorkspace = ctx.workspaceRoot ?? `${process.env.HOME}/workspaces`

  const workspaceRoot = await p.text({
    message: stepLabel(step, total, "Agent workspace path (absolute)"),
    placeholder: `${process.env.HOME}/workspaces`,
    initialValue: defaultWorkspace,
    validate: (v) => {
      if (!v) return "Required"
      if (!v.startsWith("/")) return "Must be an absolute path"
    },
  })
  if (p.isCancel(workspaceRoot)) return CANCEL

  ctx.workspaceRoot = workspaceRoot
  return
}
