/**
 * Linear-specific setup steps. Unchanged behaviour vs. the pre-split
 * setup.ts — prompts and validation messages are preserved verbatim so
 * existing users / docs remain accurate.
 *
 * Each step returns `undefined` on success, `BACK` to roll back to the
 * previous step, or `CANCEL` to abort the wizard.
 */

import * as p from "@clack/prompts"
import pc from "picocolors"
import { findWorkflowState, linearQuery } from "./linear-api"
import { BACK, CANCEL, type LinearTeam, type SetupContext, type StepResult, type WorkflowState } from "./types"
import { stepLabel } from "./ui"

function ensureLinear(ctx: SetupContext): NonNullable<SetupContext["linear"]> {
  if (!ctx.linear) ctx.linear = {}
  return ctx.linear
}

export async function stepApiKey(ctx: SetupContext, step: number, total: number): Promise<StepResult> {
  const linear = ensureLinear(ctx)
  const apiKey = await p.text({
    message: stepLabel(step, total, "Linear API Key"),
    placeholder: "lin_api_xxx",
    initialValue: linear.apiKey,
    validate: (v) => {
      if (!v) return "Required"
      if (!v.startsWith("lin_api_")) return "Must start with lin_api_. Generate one at Settings → API"
    },
  })
  if (p.isCancel(apiKey)) return CANCEL

  linear.apiKey = apiKey
  return
}

export async function stepTeam(ctx: SetupContext, step: number, total: number): Promise<StepResult> {
  const linear = ensureLinear(ctx)
  if (!linear.apiKey) return BACK

  const s = p.spinner()
  s.start("Fetching Linear teams...")

  try {
    const [teamsData, viewerData] = await Promise.all([
      linearQuery(linear.apiKey, "{ teams { nodes { id key name } } }"),
      linearQuery(linear.apiKey, "{ viewer { organization { urlKey } } }"),
    ])
    linear.teams = (teamsData as Record<string, Record<string, unknown>>).teams?.nodes as LinearTeam[]
    linear.orgUrlKey = (viewerData as Record<string, Record<string, Record<string, unknown>>>).viewer?.organization
      ?.urlKey as string
    s.stop("Teams fetched")
  } catch (e) {
    s.stop(pc.red("Linear API call failed"))
    p.log.error(`Check your API key: ${(e as Error).message}`)
    return BACK
  }

  const teams = linear.teams ?? []
  if (teams.length === 0) {
    p.log.error("No teams found. Create a team in Linear first.")
    return BACK
  }

  const teamUuid = await p.select({
    message: stepLabel(step, total, "Select a team"),
    options: teams.map((t) => ({ value: t.id, label: `${t.name} (${t.key})` })),
  })
  if (p.isCancel(teamUuid)) return CANCEL

  linear.teamUuid = teamUuid
  linear.selectedTeam = teams.find((t) => t.id === teamUuid)
  return
}

export async function stepWorkflowStates(ctx: SetupContext, step: number, total: number): Promise<StepResult> {
  const linear = ensureLinear(ctx)
  if (!linear.apiKey || !linear.teamUuid) return BACK

  const s = p.spinner()
  s.start("Fetching workflow states...")

  try {
    const data = await linearQuery(
      linear.apiKey,
      `{ team(id: "${linear.teamUuid}") { states { nodes { id name type } } } }`,
    )
    linear.states = (data as Record<string, Record<string, Record<string, unknown>>>).team?.states
      ?.nodes as WorkflowState[]
    s.stop("Workflow states fetched")
  } catch (e) {
    s.stop(pc.red("Failed to fetch workflow states"))
    p.log.error((e as Error).message)
    return BACK
  }

  const states = linear.states ?? []
  const todoState = findWorkflowState(states, ["Todo"], "unstarted")
  const inProgressState = findWorkflowState(states, ["In Progress"], "started")
  const doneState = findWorkflowState(states, ["Done"], "completed")
  const cancelledState = findWorkflowState(states, ["Canceled", "Cancelled"], "canceled")

  const fmt = (label: string, st: WorkflowState | undefined) =>
    st ? `${label}: ${pc.green(st.name)} ${pc.dim(st.id)}` : `${label}: ${pc.red("mapping failed")}`

  p.note(
    [
      fmt("Todo", todoState),
      fmt("In Progress", inProgressState),
      fmt("Done", doneState),
      fmt("Cancelled", cancelledState),
    ].join("\n"),
    stepLabel(step, total, "Workflow State Mapping"),
  )

  const stateOptions = states.map((st) => ({ value: st.id, label: `${st.name} (${st.type})` }))

  const selectMissing = async (label: string, current: WorkflowState | undefined) => {
    if (current) return current
    const id = await p.select({ message: `Select the ${label} state`, options: stateOptions })
    if (p.isCancel(id)) return CANCEL
    const found = states.find((st) => st.id === id)
    if (!found) return CANCEL
    return found
  }

  const todo = await selectMissing("Todo", todoState)
  if (todo === CANCEL) return CANCEL
  const inProgress = await selectMissing("In Progress", inProgressState)
  if (inProgress === CANCEL) return CANCEL
  const done = await selectMissing("Done", doneState)
  if (done === CANCEL) return CANCEL
  const cancelled = await selectMissing("Cancelled", cancelledState)
  if (cancelled === CANCEL) return CANCEL

  linear.todoStateId = (todo as WorkflowState).id
  linear.inProgressStateId = (inProgress as WorkflowState).id
  linear.doneStateId = (done as WorkflowState).id
  linear.cancelledStateId = (cancelled as WorkflowState).id
  return
}

export async function stepWebhook(ctx: SetupContext, step: number, total: number): Promise<StepResult> {
  const linear = ensureLinear(ctx)
  if (!linear.orgUrlKey || !linear.selectedTeam) return BACK

  const webhookUrl = `https://linear.app/${linear.orgUrlKey}/settings/api`

  p.note(
    [
      `Go to ${pc.cyan(webhookUrl)}:`,
      "",
      `1. Click ${pc.bold("Create webhook")}`,
      `2. Label: ${pc.dim("Symphony")}`,
      `3. URL: your ngrok tunnel URL + ${pc.bold("/webhook")}`,
      `4. Events: check ${pc.bold("Issues")}`,
      `5. Team: select ${pc.bold(linear.selectedTeam.name)}`,
      `6. Copy the Signing secret after creation`,
    ].join("\n"),
    stepLabel(step, total, "Webhook Setup Guide"),
  )

  const ready = await p.confirm({ message: "Have you completed the webhook setup in Linear?" })
  if (p.isCancel(ready)) return CANCEL
  if (!ready) return BACK

  const webhookSecret = await p.text({
    message: "Webhook Signing Secret",
    placeholder: "lin_wh_xxx",
    initialValue: linear.webhookSecret,
    validate: (v) => {
      if (!v) return "Required"
    },
  })
  if (p.isCancel(webhookSecret)) return CANCEL

  linear.webhookSecret = webhookSecret
  return
}
