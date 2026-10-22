import { join } from "node:path"
import { MissionPause, reconcileExecution, recordPause } from "@agent-valley/core/chief/execution"
import { fallbackReport } from "@agent-valley/core/chief/reports"
import { MissionStore } from "@agent-valley/core/chief/store"
import type { Mission } from "@agent-valley/core/chief/types"
import type { Command } from "commander"
import { assertNotManagedRun } from "./managed-run"

export interface ExecutionReconciliationOptions {
  run: string
  evidence: string
}

/** Record operator-provided termination evidence without continuing the mission. */
export async function reconcileMissionExecution(
  missionId: string,
  options: ExecutionReconciliationOptions,
  root = process.cwd(),
): Promise<Mission> {
  assertNotManagedRun()
  const runId = options.run?.trim()
  const evidence = options.evidence?.trim()
  if (!runId || runId.length > 2_000 || !evidence || evidence.length > 2_000)
    throw new Error(
      "Set --run to the uncertain execution ID and --evidence to 1–2,000 characters describing how you confirmed it stopped.",
    )
  const store = new MissionStore(join(root, ".agent-valley", "missions"))
  const unlock = await store.lock(missionId)
  try {
    const mission = await store.load(missionId)
    const run = mission.operations?.runs.find((entry) => entry.runId === runId)
    if (run?.executionState !== "unknown")
      throw new Error(
        "The selected run is not an uncertain execution. Inspect the saved mission and use the run ID from its unknown-outcome error.",
      )
    // A statement of termination cannot override a live or uncertain local process guard.
    // Keep reconciliation explicit rather than letting marker recovery settle this record first.
    await store.recoverProcesses(missionId)
    reconcileExecution(mission, runId, evidence)
    recordPause(
      mission,
      new MissionPause(
        `Runtime execution ${runId} termination was reconciled. The mission remains paused; inspect task effects, reviews and billing before explicitly resuming.`,
        "interrupted",
      ),
    )
    mission.updatedAt = new Date().toISOString()
    mission.report = fallbackReport(mission)
    await store.save(mission)
    return mission
  } finally {
    await unlock()
  }
}

export function registerMissionReconciliation(missions: Command, root = process.cwd()): void {
  missions
    .command("reconcile <mission-id>")
    .description("Record evidence that an uncertain execution stopped; leave its mission paused")
    .requiredOption("--run <run-id>", "Uncertain runtime execution ID from the saved mission")
    .requiredOption("--evidence <text>", "Observed termination evidence, up to 2,000 characters")
    .action(async (missionId: string, options: ExecutionReconciliationOptions, command: Command) => {
      if (command.parent?.opts().watch)
        throw new Error("Omit --watch when reconciling an execution. Reconciliation leaves the mission paused.")
      const mission = await reconcileMissionExecution(missionId, options, root)
      console.log(`Execution ${options.run.trim()} reconciled for mission ${mission.id}; the mission remains paused.`)
      console.log(
        `After inspecting effects, reviews and billing, resume explicitly: av order --resume ${mission.id} --retry`,
      )
    })
}
