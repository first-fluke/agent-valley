import * as p from "@clack/prompts"
import { inspectOma, prepareOma } from "../oma-provisioning"
import { BACK, CANCEL, type SetupContext, type StepResult } from "./types"
import { stepLabel } from "./ui"

export async function stepOma(ctx: SetupContext, step: number, total: number): Promise<StepResult> {
  const workspaceRoot = ctx.workspaceRoot
  if (!workspaceRoot) {
    p.log.warn("Select the target workspace before preparing OMA skills.")
    return BACK
  }

  const state = await inspectOma(workspaceRoot)
  p.note(`${workspaceRoot}\n${state.message}`, "OMA skills")
  let retry = false
  while (true) {
    const action = await p.select({
      message: stepLabel(step, total, retry ? "OMA preparation failed. Next step?" : "Prepare OMA skills?"),
      initialValue: "prepare",
      options: [
        {
          value: "prepare",
          label: retry ? "Retry" : state.success ? "Update OMA" : "Install OMA",
          hint: "Latest release, all skills; preserves custom configuration",
        },
        { value: "later", label: "Prepare later", hint: "Continue setup without preparing OMA" },
        { value: "back", label: "Back" },
        { value: "cancel", label: "Cancel setup" },
      ],
    })
    if (p.isCancel(action) || action === "cancel") return CANCEL
    if (action === "back") return BACK
    if (action === "later") {
      p.log.warn(
        `OMA preparation deferred for ${workspaceRoot}. Run av setup --edit and select OMA skills (install/update) to prepare all latest skills.`,
      )
      return
    }
    if (action !== "prepare") return CANCEL
    p.log.info(`Preparing OMA and all available skills in ${workspaceRoot}.`)
    const result = await prepareOma(workspaceRoot)
    if (result.success) {
      p.log.success(result.message)
      return
    }
    p.log.warn(result.message)
    retry = true
  }
}
