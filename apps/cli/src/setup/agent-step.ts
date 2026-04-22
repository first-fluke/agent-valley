/**
 * Agent type selection. Shared by all tracker flows — agent choice is a
 * user preference, independent of which tracker is issuing work.
 */

import * as p from "@clack/prompts"
import { type AgentType, CANCEL, type SetupContext, type StepResult } from "./types"
import { stepLabel } from "./ui"

export async function stepAgentType(ctx: SetupContext, step: number, total: number): Promise<StepResult> {
  const agentType = await p.select({
    message: stepLabel(step, total, "Select agent"),
    options: [
      { value: "claude", label: "Claude", hint: "Anthropic Claude Code" },
      { value: "codex", label: "Codex", hint: "OpenAI Codex" },
      { value: "gemini", label: "Gemini", hint: "Google Gemini" },
    ],
  })
  if (p.isCancel(agentType)) return CANCEL

  ctx.agentType = agentType as AgentType
  return
}
