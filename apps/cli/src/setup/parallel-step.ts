/**
 * Hardware detection + parallel agent count selection.
 */

import { detectHardware } from "@agent-valley/core/config/hardware"
import * as p from "@clack/prompts"
import pc from "picocolors"
import { CANCEL, type SetupContext, type StepResult } from "./types"
import { stepLabel } from "./ui"

export async function stepParallel(ctx: SetupContext, step: number, total: number): Promise<StepResult> {
  const hw = detectHardware()

  p.note(
    [
      `CPU: ${pc.cyan(String(hw.cpuCores))} cores`,
      `RAM: ${pc.cyan(String(hw.totalMemoryGB))} GB`,
      `Recommended parallel agents: ${pc.green(String(hw.recommended))}`,
    ].join("\n"),
    stepLabel(step, total, "Hardware Detection"),
  )

  const useRecommended = await p.confirm({
    message: `Set parallel agents to ${pc.green(String(hw.recommended))}?`,
    initialValue: true,
  })
  if (p.isCancel(useRecommended)) return CANCEL

  if (useRecommended) {
    ctx.maxParallel = hw.recommended
  } else {
    const custom = await p.text({
      message: "Number of parallel agents",
      initialValue: String(ctx.maxParallel ?? hw.cpuCores),
      validate: (v) => {
        const n = Number(v)
        if (!Number.isInteger(n) || n < 1) return "Must be a positive integer"
      },
    })
    if (p.isCancel(custom)) return CANCEL
    ctx.maxParallel = Number(custom)
  }

  return
}
