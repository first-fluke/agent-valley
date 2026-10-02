import * as p from "@clack/prompts"
import { CANCEL, type SetupContext, type StepResult } from "./types"
import { stepLabel } from "./ui"

/** Collect the evidence required for a task to reach Done. */
export async function stepCompletion(ctx: SetupContext, step: number, total: number): Promise<StepResult> {
  const kind = await p.select({
    message: stepLabel(step, total, "Task output"),
    initialValue: ctx.task?.kind ?? "code",
    options: [
      { value: "code", label: "Code changes", hint: "Require a passing verification command" },
      { value: "analysis", label: "Analysis report", hint: "Require a report from this run" },
    ],
  })
  if (p.isCancel(kind)) return CANCEL
  if (kind === "analysis") {
    const reportPath = await p.text({
      message: "Report path relative to the workspace (must contain {{attempt.id}})",
      initialValue: ctx.task?.kind === "analysis" ? ctx.task.report_path : "reports/{{attempt.id}}.md",
      validate: (value) => {
        if (!value?.includes("{{attempt.id}}")) return "Include {{attempt.id}} to identify this run's report"
        if (value.startsWith("/") || value.startsWith("\\") || value.split(/[\\/]/).includes("..")) {
          return "Use a relative path inside the workspace, without .."
        }
      },
    })
    if (p.isCancel(reportPath)) return CANCEL
    ctx.task = { kind: "analysis", report_path: reportPath }
    ctx.verifyCommand = undefined
  } else {
    const command = await p.text({
      message: "Verification command to run in each task workspace",
      placeholder: "bun run test",
      initialValue: ctx.verifyCommand,
      validate: (value) =>
        value?.trim() ? undefined : "Enter an existing test or validation command for this project",
    })
    if (p.isCancel(command)) return CANCEL
    ctx.task = { kind: "code" }
    ctx.verifyCommand = command.trim()
  }
  return undefined
}
