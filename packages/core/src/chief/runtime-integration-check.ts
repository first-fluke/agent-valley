import type { ActiveMissionProcess } from "./active-process"
import { finishLocalProcess } from "./local-runner"
import type { Mission } from "./types"
import { executeCommandChecks } from "./verification"
import { assertMissionWorkspace } from "./workspace"

export const INTEGRATION_CHECK_ENV = "AV_INTEGRATION_CHECK"

/** Opt-in while its cost and benefit are measured: `AV_INTEGRATION_CHECK=1` runs contract commands between waves. */
export function integrationCheckEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  return source[INTEGRATION_CHECK_ENV] === "1"
}

/** Runs under the same process guard as verification so an interrupted check is reclaimed on resume. */
export async function runIntegrationCheck(
  mission: Mission,
  active: ActiveMissionProcess,
  signal?: AbortSignal,
): Promise<{ ok: boolean; output: string } | undefined> {
  if (!mission.verificationContract) return undefined
  await assertMissionWorkspace(mission)
  active.begin("verify")
  try {
    return await executeCommandChecks(mission.verificationContract, mission.workspace.path, {
      successCriteria: mission.goalBrief?.successCriteria ?? [],
      timeoutMs: mission.timeoutSec * 1_000,
      signal,
      onSpawned: (pid, detached) => active.spawned(pid, detached),
    })
  } finally {
    await finishLocalProcess(active)
  }
}
