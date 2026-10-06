import { consultDirectors } from "./advisor-coordination"
import {
  ensureCurrentMissionContainers,
  refreshMissionContainers,
  verifyMissionContainers,
} from "./coordinator-container"
import { performParallelWave } from "./coordinator-parallel"
import { createChiefRecovery } from "./coordinator-recovery"
import { createMissionReporter } from "./coordinator-report"
import { CheckpointError, createMissionRun, ReadOnlyViolation } from "./coordinator-run"
import { ContractViolation, createMissionContract, resetTaskApprovals } from "./coordinator-state"
import {
  assertExecutionDeadline,
  chiefRecoveryStopped,
  classifyFailure,
  executionState,
  finalizeAbandonedRuns,
  MissionPause,
  pauseForFailure,
  recordPause,
} from "./execution"
import { readyTaskWave } from "./parallel"
import { ParallelIntegrationConflict } from "./parallel-workspace"
import { planPrompt, reviewPrompt, workPrompt } from "./prompts"
import { fallbackReport } from "./reports"
import { selectTaskReviewer } from "./review-routing"
import { recordTaskVerdict } from "./routing"
import { parseFinalReview, parsePlanningResponse, parseReview, validateMission } from "./schemas"
import { assignTaskStates } from "./supervision"
import type { ChiefPorts, ChiefTask, ChiefTaskState, Mission, Persona } from "./types"
import { goalVerificationContractDigest } from "./verification"

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
  const save = async (stage: string, message: string, taskId?: string) => {
    assertContract()
    mission.updatedAt = new Date().toISOString()
    mission.history.push({ at: mission.updatedAt, stage, message, ...(taskId ? { taskId } : {}) })
    try {
      await ports.save(mission)
    } catch {
      throw new CheckpointError(
        "Mission checkpoint could not be saved. Restore writable mission storage before resuming.",
      )
    }
  }
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
  const run = createMissionRun(mission, ports, assertContract, checkAbort)
  const generateReport = createMissionReporter(mission, ports, run, persona, fatal)
  const requestRecovery = createChiefRecovery(mission, ports, { run, persona, save, checkAbort })
  const taskReview = async (task: ChiefTask, state: ChiefTaskState) => {
    const reviewer = selectTaskReviewer(mission, task, state)
    state.status = "reviewing"
    mission.status = "reviewing"
    await save("review", `Reviewing ${task.id} with ${state.reviewerId}.`, task.id)
    state.review = parseReview(await run(reviewer, reviewPrompt(mission, task, state), "review", task.id))
    recordTaskVerdict(mission, task.id, state.review.passed, state.review.summary)
    state.fingerprint = mission.fingerprint
    await save("review", state.review.summary, task.id)
  }
  const performTask = async (task: ChiefTask, state: ChiefTaskState) => {
    while (state.status !== "completed") {
      checkAbort()
      state.status = "running"
      if (task.effectScope !== "external" || state.effectState !== "completed") state.attempts += 1
      if (task.effectScope === "external") state.effectState ??= "not-started"
      mission.status = "executing"
      await save("work", `Running ${task.id} with ${task.personaId}, attempt ${state.attempts}.`, task.id)
      try {
        if (task.effectScope === "external" && state.effectState === "unknown")
          throw new MissionPause(
            `External effect ${task.id} has no established destination outcome and will not be repeated.`,
            "unknown-effect",
          )
        if (task.effectScope !== "external" || state.effectState !== "completed") {
          state.output = bounded(
            await run(
              persona(task.personaId),
              workPrompt(mission, task, state, persona(task.personaId)),
              "work",
              task.id,
            ),
          )
          if (task.effectScope === "external") state.effectState = "completed"
        }
        await save("work", `Worker returned evidence for ${task.id}.`, task.id)
        await taskReview(task, state)
      } catch (error) {
        recordTaskVerdict(mission, task.id, false, error instanceof Error ? error.message : String(error))
        if (!mission.supervision || protectedFailure(error)) throw error
        state.status = "pending"
        if (state.effectState !== "unknown")
          pauseForFailure(mission, error instanceof Error ? error.message : String(error), task.id)
        await requestRecovery(error instanceof Error ? error.message : String(error), task.id)
        return
      }
      if (state.review?.passed) {
        state.status = "completed"
        await save("task-completed", `Task ${task.id} passed independent review.`, task.id)
        continue
      }
      if (task.effectScope === "external") {
        await requestRecovery(
          `External action ${task.id} completed but failed independent review: ${state.review?.findings.join("; ")}. Preserve its completed effect; any new external repair requires a separate task.`,
          task.id,
        )
        return
      }
      if ((state.repairRound ?? 0) >= mission.maxRepairs) {
        if (mission.supervision) {
          await requestRecovery(
            `Task ${task.id} exhausted local repairs after independent review: ${state.review?.findings.join("; ")}`,
            task.id,
          )
          return
        }
        throw new Error(
          `Task ${task.id} failed review after ${mission.maxRepairs} repairs. Resolve the recorded findings before resuming.`,
        )
      }
      state.repairRound = (state.repairRound ?? 0) + 1
      state.status = "pending"
      await save("repair", `Repairing findings for ${task.id}.`, task.id)
    }
  }
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

  try {
    finalizeAbandonedRuns(mission)
    checkAbort()
    assertExecutionDeadline(mission)
    if (mission.execution?.failureKind === "chief-wait") {
      if (Date.parse(mission.execution.nextRunAt ?? "") > Date.now()) return mission
      delete mission.execution.nextRunAt
      delete mission.execution.pauseReason
      delete mission.execution.failureKind
    }
    const current = await ports.fingerprint(mission)
    mission.initialFingerprint ??= current
    if (mission.supervision) {
      mission.supervision.operatorGoal ??= operatorGoal
      mission.supervision.operatorVerifyCommand ??= operatorVerify
      mission.supervision.lastFingerprint ??= current
    }
    if (mission.fingerprint && mission.fingerprint !== current) {
      invalidate()
      await save("resume", "Worktree changed since the checkpoint; all task reviews will run again.")
    }
    mission.fingerprint = current
    delete mission.error
    delete mission.report
    for (const task of mission.tasks) {
      if (task.status === "running" || task.status === "reviewing") {
        if (task.effectState === "running") task.effectState = "unknown"
        task.status = "pending"
      }
      if (
        task.effectState === "unknown" &&
        !(mission.supervision?.pendingRecovery && mission.supervision.decisions.at(-1)?.action === "wait")
      )
        throw new MissionPause(
          `External effect ${task.id} was interrupted. No trustworthy destination proof establishes its outcome; its evidence is retained and it will not be repeated.`,
          "unknown-effect",
        )
    }
    await save("resume", "Mission checkpoint loaded.")
    const stopped = mission.supervision?.decisions.at(-1)
    if (chiefRecoveryStopped(mission))
      throw new Error(
        `Chief Director stopped before achieving the goal: ${stopped?.reason}. The original goal remains unresolved.`,
      )
    if (!mission.plan) {
      await refreshMissionContainers(mission, ports)
      checkAbort()
      if (mission.containerObservationPolicy?.enabled)
        await save("container-observation", "Collected configured container evidence for mission planning.")
      await consultDirectors(mission, ports, { run, save })
      mission.status = "planning"
      await save("plan", "Chief Director is planning the mission.")
      const planned = parsePlanningResponse(await run(persona(mission.chiefId), planPrompt(mission), "plan"), mission)
      const tasks = assignTaskStates({ ...mission, personas: planned.personas }, planned.plan)
      mission.personas = planned.personas
      mission.plan = planned.plan
      mission.tasks = tasks
      if (planned.goalBrief) {
        mission.goalBrief = planned.goalBrief
        if (mission.supervision)
          mission.supervision.originalAcceptance = [...new Set(planned.plan.tasks.flatMap((task) => task.acceptance))]
      }
      if (planned.verificationContract) {
        mission.verificationContract = planned.verificationContract
        mission.verificationContractSha256 = goalVerificationContractDigest(planned.verificationContract)
      }
      contract.pin()
      await save("plan", `Chief Director planned ${mission.tasks.length} tasks.`)
    }
    if (mission.supervision?.pendingRecovery) {
      const pending = mission.supervision.pendingRecovery
      await requestRecovery(pending.reason, pending.taskId)
    }
    while (true) {
      checkAbort()
      while (mission.tasks.some((state) => state.status !== "completed")) {
        const limit = mission.executionPolicy?.maxParallel ?? 1
        const wave = readyTaskWave(mission.plan, mission.tasks, limit).filter((task) => task.effectScope !== "external")
        if (
          ports.parallel &&
          limit > 1 &&
          (wave.length > 1 || wave.some((task) => mission.tasks.find((state) => state.id === task.id)?.parallel))
        ) {
          const failures = await performParallelWave(mission, ports, wave, {
            run,
            save,
            review: taskReview,
            fatal: protectedFailure,
          })
          const unrecoverable = failures.find((failure) => protectedFailure(failure.error))
          if (unrecoverable) throw unrecoverable.error
          for (const failure of failures) {
            recordTaskVerdict(mission, failure.taskId, false, failure.reason)
            pauseForFailure(mission, failure.reason, failure.taskId)
            const state = mission.tasks.find((task) => task.id === failure.taskId)
            if (!state) throw new Error("Recovery task disappeared. Restore the recorded plan.")
            if (
              failure.error instanceof ParallelIntegrationConflict ||
              ["environment", "authentication", "provider", "rate-limit"].includes(classifyFailure(failure.reason))
            ) {
              await requestRecovery(failure.reason, failure.taskId)
              break
            }
            if ((state.repairRound ?? 0) < mission.maxRepairs) {
              state.repairRound = (state.repairRound ?? 0) + 1
              await save("repair", failure.reason, failure.taskId)
            } else {
              await requestRecovery(failure.reason, failure.taskId)
              break
            }
          }
          continue
        }
        const task = mission.plan.tasks.find(
          (entry) =>
            mission.tasks.some((state) => state.id === entry.id && state.status !== "completed") &&
            entry.dependencies.every((id) =>
              mission.tasks.some((state) => state.id === id && state.status === "completed"),
            ),
        )
        const state = mission.tasks.find((entry) => entry.id === task?.id)
        if (!task || !state) throw new Error("No task can run. Restore an acyclic plan with complete dependency state.")
        await performTask(task, state)
      }
      mission.status = "verifying"
      await save("verify", "Running the operator's verification command.")
      checkAbort()
      let result: { ok: boolean; output?: string }
      try {
        result = await ports.verify(mission)
        assertContract()
      } catch (error) {
        if (!mission.supervision || protectedFailure(error)) throw error
        await requestRecovery(`Verification process failed: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      checkAbort()
      mission.fingerprint = await ports.fingerprint(mission)
      mission.verification = {
        ok: result.ok,
        output: result.output ? bounded(result.output) : undefined,
        fingerprint: mission.fingerprint,
      }
      if (mission.verificationMode === "chief" && !mission.goalVerification?.ok) {
        mission.verification.ok = false
        mission.verification.output =
          mission.goalVerification?.output ??
          "No actual goal verification observations were recorded. Execute the immutable checks."
      }
      if (mission.fingerprint === mission.initialFingerprint) {
        mission.verification.ok = false
        mission.verification.output =
          "No material deliverable changed in the worktree. Create the requested code or report artifact."
      }
      await save("verify", mission.verification.ok ? "Verification passed." : "Verification failed.")
      if (!mission.verification.ok) {
        await requestRepair(mission.verification.output ?? "The operator's verification command failed")
        continue
      }
      mission.status = "reviewing"
      const recovery = await verifyMissionContainers(mission, ports, save, checkAbort)
      if (!recovery.healthy) {
        await requestRecovery(`Configured service recovery remains unresolved after code checks: ${recovery.reason}`)
        continue
      }
      if (ports.refreshOrganization) {
        mission.organizationContext = await ports.refreshOrganization(mission)
        await save(
          "organization",
          "Loaded current operator-recorded metrics and organization evidence for final review.",
        )
      }
      if (ports.observeMetrics && mission.metricSourcePolicy && mission.operatingPolicy?.metricTargets?.length) {
        mission.observationStartedAt ??= new Date().toISOString()
        await save("observation", "Observing fresh business measurements against the original metric targets.")
        const observation = await ports.observeMetrics(mission)
        checkAbort()
        if (observation.status === "waiting") {
          recordPause(mission, new MissionPause(observation.reason, "provider", observation.nextPollAt))
          await save("waiting", observation.reason)
          mission.report = fallbackReport(mission)
          await ports.save(mission)
          return mission
        }
        if (observation.status === "failed") {
          delete mission.observationStartedAt
          await requestRecovery(`Business measurement did not meet the original target: ${observation.reason}`)
          continue
        }
      }
      await save("final-review", "Chief Director is reviewing the completed mission and verification evidence.")
      try {
        mission.finalReview = parseFinalReview(
          await run(persona(mission.chiefId), reviewPrompt(mission), "final-review"),
          mission,
        )
      } catch (error) {
        if (!mission.supervision || protectedFailure(error)) throw error
        pauseForFailure(mission, error instanceof Error ? error.message : String(error))
        await requestRecovery(
          `Final review could not complete: ${error instanceof Error ? error.message : String(error)}`,
        )
        continue
      }
      await save("final-review", mission.finalReview.summary)
      if (!mission.finalReview.passed) {
        await requestRepair(mission.finalReview.findings.join("; "))
        continue
      }
      if ((await ports.fingerprint(mission)) !== mission.verification.fingerprint) {
        throw new Error("Worktree changed after verification. Resume to rerun task reviews and verification.")
      }
      if (!(await ensureCurrentMissionContainers(mission, ports, save, checkAbort, requestRecovery))) continue
      await generateReport()
      if ((await ports.fingerprint(mission)) !== mission.verification.fingerprint)
        throw new ReadOnlyViolation(
          "Worktree changed after the Chief Director report. Resume to refresh verification and approvals.",
        )
      if (!(await ensureCurrentMissionContainers(mission, ports, save, checkAbort, requestRecovery))) continue
      mission.status = "completed"
      await save(
        "completed",
        "Every task passed independent review, verification passed, and the Chief Director approved the mission.",
      )
      return mission
    }
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
