import { CODE_SKILL } from "./coordinator-state"
import { MissionPause } from "./execution"
import type { ChiefPorts, ChiefTaskState, Mission } from "./types"

/**
 * Task reviewers only read files, and Actors run focused tests in their own workspaces, so a regression in
 * another part of the tree used to surface only at the final gate, where each repair repeats every gate.
 * After code is integrated and before it is reviewed, AV runs the contract's command checks once and hands
 * the observed result to the reviewers of that delivery. It is evidence, not a verdict: a check may fail
 * because a later task has not delivered yet, and the reviewer decides what the delivery under review owns.
 */
export async function recordIntegrationCheck(
  mission: Mission,
  ports: ChiefPorts,
  states: readonly ChiefTaskState[],
  save: (stage: string, message: string, taskId?: string) => Promise<void>,
): Promise<void> {
  if (!ports.integrationCheck) return
  const codeTask = (state: ChiefTaskState) => {
    const task = mission.plan?.tasks.find((entry) => entry.id === state.id)
    const persona = mission.personas.find((entry) => entry.id === task?.personaId)
    return !!task && task.effectScope !== "external" && !!persona?.skills.some((skill) => CODE_SKILL.test(skill))
  }
  const targets = states.filter((state) => state.output !== undefined && !state.integrationCheck && codeTask(state))
  const first = targets[0]
  if (!first) return
  let result: { ok: boolean; output: string } | undefined
  try {
    result = await ports.integrationCheck(mission)
  } catch (error) {
    if (ports.signal?.aborted || error instanceof MissionPause) throw error
    await save(
      "integration-check",
      `Integration check could not run and was skipped: ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        2_000,
      ),
      first.id,
    )
    return
  }
  if (!result) return
  const observed = { at: new Date().toISOString(), ok: result.ok, output: result.output.slice(0, 8_000) }
  for (const state of targets) state.integrationCheck = observed
  await save(
    "integration-check",
    `${result.ok ? "Contract command checks pass" : "Contract command checks fail"} on the integrated tree before review of ${targets.map((state) => state.id).join(", ")}.${result.ok ? "" : ` ${result.output.slice(0, 1_500)}`}`,
    first.id,
  )
}
