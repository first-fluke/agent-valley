import { createMissionCheckpoint } from "./coordinator-checkpoint"
import { runCoordinatorGraph } from "./coordinator-graph"
import { createChiefRecovery } from "./coordinator-recovery"
import { createMissionReporter } from "./coordinator-report"
import { CheckpointError, createMissionRun, ReadOnlyViolation } from "./coordinator-run"
import type { CoordinatorContext } from "./coordinator-stages"
import { ContractViolation, createMissionContract, resetTaskApprovals } from "./coordinator-state"
import { executionState, MissionPause, pauseForFailure, recordPause } from "./execution"
import { fallbackReport } from "./reports"
import { validateMission } from "./schemas"
import type { ChiefPorts, Mission, Persona } from "./types"

const bounded = (value: string) => value.slice(-32_000)

/** Coordinator owns state; all child runs are joined before review, recovery or return. */
export async function coordinate(mission: Mission, ports: ChiefPorts): Promise<Mission> {
  Object.assign(mission, validateMission(mission))
  const operatorGoal = mission.goal
  const operatorVerify = mission.verifyCommand
  const contract = createMissionContract(mission)
  const assertContract = contract.assert
  const persona = (id: string): Persona => {
    const found = mission.personas.find((entry) => entry.id === id)
    if (!found) throw new Error(`Unknown Actor ${id}. Restore the configured Actor before resuming.`)
    return found
  }
  const checkAbort = () => {
    if (ports.signal?.aborted) {
      if (ports.signal.reason instanceof MissionPause) throw ports.signal.reason
      throw new Error("Mission interrupted. Resume the saved mission to continue.")
    }
  }
  const checkpoint = createMissionCheckpoint(mission, ports, assertContract)
  const save = checkpoint.record
  const fatal = (error: unknown) =>
    ports.signal?.aborted ||
    error instanceof ReadOnlyViolation ||
    error instanceof ContractViolation ||
    error instanceof CheckpointError
  const protectedFailure = (error: unknown) =>
    fatal(error) ||
    (error instanceof MissionPause &&
      (Boolean(error.nextRunAt) || ["budget", "interrupted", "chief-unavailable"].includes(error.kind)))
  const invalidate = () => {
    resetTaskApprovals(mission, { preserveUnfinished: true })
    delete mission.finalReview
    delete mission.verification
  }
  const run = createMissionRun(mission, ports, assertContract, checkAbort, checkpoint.persist)
  const generateReport = createMissionReporter(mission, ports, run, persona, fatal)
  const requestRecovery = createChiefRecovery(mission, ports, { run, persona, save, checkAbort })
  const requestRepair = async (reason: string) => {
    if ((mission.repairRound ?? 0) >= mission.maxRepairs) {
      if (mission.supervision) {
        await requestRecovery(reason)
        return
      }
      throw new Error(
        `Mission failed after ${mission.maxRepairs} repair rounds: ${reason}. Inspect the evidence before resuming.`,
      )
    }
    mission.repairRound = (mission.repairRound ?? 0) + 1
    // Preserve rejection evidence in prompts; invalidate all task approvals because repair may affect dependencies.
    resetTaskApprovals(mission, { keepReviews: true })
    await save("repair", reason)
  }

  const context: CoordinatorContext = {
    mission,
    ports,
    operatorGoal,
    operatorVerify,
    contract,
    checkpoint,
    run,
    generateReport,
    requestRecovery,
    requestRepair,
    persona,
    save,
    assertContract,
    checkAbort,
    protectedFailure,
    invalidate,
  }
  try {
    await runCoordinatorGraph(context)
    return mission
  } catch (error) {
    if (!(error instanceof MissionPause) && mission.executionPolicy && !fatal(error)) {
      try {
        pauseForFailure(mission, error instanceof Error ? error.message : String(error))
      } catch (pause) {
        if (!(pause instanceof MissionPause)) throw pause
        recordPause(mission, pause)
        mission.report = fallbackReport(mission)
        await save(mission.status, pause.message)
        return mission
      }
    }
    if (error instanceof MissionPause) {
      recordPause(mission, error)
      mission.report = fallbackReport(mission)
      await save(mission.status, error.message)
      return mission
    }
    if (ports.signal?.aborted && mission.executionPolicy) {
      recordPause(
        mission,
        new MissionPause(
          "Mission interrupted. Its checks, budget and child workspace records were retained for resume.",
          "interrupted",
        ),
      )
      mission.report = fallbackReport(mission)
      await save("paused", mission.error ?? "Mission interrupted.")
      return mission
    }
    mission.status = "failed"
    mission.error = bounded(error instanceof Error ? error.message : String(error))
    if (error instanceof ReadOnlyViolation || error instanceof ContractViolation || error instanceof CheckpointError)
      executionState(mission).failureKind = "integrity"
    if (error instanceof ReadOnlyViolation) invalidate()
    await save("failed", mission.error)
    if (mission.supervision) {
      if (fatal(error)) mission.report = fallbackReport(mission)
      else {
        try {
          await generateReport()
        } catch (reportError) {
          mission.report = fallbackReport(mission)
          if (reportError instanceof ReadOnlyViolation) {
            executionState(mission).failureKind = "integrity"
            invalidate()
            mission.error = bounded(`${mission.error}\n${reportError.message}`)
            mission.report = fallbackReport(mission)
          }
        }
      }
      await save("report", "Chief Director outcome report records the unresolved goal.")
    }
    throw error
  }
}
