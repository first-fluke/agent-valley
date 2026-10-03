import * as p from "@clack/prompts"
import { AGENT_PROVISIONING, inspectChiefAgent, installChiefAgent, loginChiefAgent } from "../agent-provisioning"
import { type AgentType, CANCEL, type SetupContext, type StepResult } from "./types"
import { stepLabel } from "./ui"

export async function stepAgentType(ctx: SetupContext, step: number, total: number): Promise<StepResult> {
  const agentType = await p.select({
    message: stepLabel(step, total, "Select Chief Director vendor"),
    initialValue: ctx.agentType ?? "claude",
    options: [
      { value: "claude", label: "Claude", hint: "Anthropic Claude Code" },
      { value: "codex", label: "Codex", hint: "OpenAI Codex" },
      { value: "antigravity", label: "Antigravity", hint: "Google Antigravity (agy)" },
      { value: "cursor", label: "Cursor", hint: "Cursor Agent" },
      { value: "grok", label: "Grok", hint: "xAI Grok Build" },
      { value: "kimi", label: "Kimi", hint: "Moonshot AI Kimi Code" },
      { value: "opencode", label: "opencode", hint: "Multi-provider (75+ backends)" },
    ],
  })
  if (p.isCancel(agentType)) return CANCEL

  const selected = agentType as AgentType
  const model = await p.text({
    message: "Chief Director model (optional; blank uses the CLI default)",
    placeholder: "Native CLI default",
    initialValue: ctx.agentType === selected ? ctx.agentModel : undefined,
    validate: (value) => {
      if (value && (value.trim().length > 200 || [...value].some((char) => char.charCodeAt(0) < 32))) {
        return "Enter a model ID of at most 200 characters on one line."
      }
    },
  })
  if (p.isCancel(model)) return CANCEL
  ctx.agentType = selected
  if (model.trim()) ctx.agentModel = model.trim()
  else delete ctx.agentModel

  const plan = AGENT_PROVISIONING[selected]
  while (true) {
    const state = await inspectChiefAgent(selected)
    if (state.readiness === "ready") {
      p.log.success(`${plan.label} Chief Director is ready. Available worker CLIs are selected automatically.`)
      return
    }
    p.note(state.reason, `${plan.label} setup`)
    const action = await p.select({
      message:
        state.readiness === "unavailable" ? `Install and sign in to ${plan.label}?` : `Sign in to ${plan.label}?`,
      initialValue: "setup",
      options: [
        {
          value: "setup",
          label: state.readiness === "unavailable" ? "Install and sign in" : "Sign in",
          hint: "Use the vendor's native flow",
        },
        { value: "recheck", label: "Recheck", hint: "After completing setup in another terminal" },
        {
          value: "later",
          label: "Configure later",
          hint: "Save the selection; Chief Director readiness remains unverified",
        },
        { value: "cancel", label: "Cancel setup" },
      ],
    })
    if (p.isCancel(action) || action === "cancel") return CANCEL
    if (action === "later") {
      p.log.warn(
        `${plan.label} Chief Director is not verified as ready. Complete installation/login and rerun av setup before av order.`,
      )
      return
    }
    if (action === "recheck") continue
    if (action !== "setup") return CANCEL

    if (state.readiness === "unavailable") {
      p.log.info(`Installing ${plan.label} from the vendor's official distribution.`)
      const installed = await installChiefAgent(selected)
      if (!installed.success) {
        p.log.warn(installed.message)
        continue
      }
      const afterInstall = await inspectChiefAgent(selected)
      if (afterInstall.readiness === "ready") continue
      if (afterInstall.readiness === "unavailable") {
        p.log.warn("The CLI is still unavailable. Check your PATH, open a new terminal if needed, and choose Recheck.")
        continue
      }
    }
    p.note(plan.loginInstructions, `${plan.label} sign-in`)
    const login = await loginChiefAgent(selected)
    if (!login.success) p.log.warn(login.message)
  }
}
